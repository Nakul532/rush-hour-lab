// The acceptance rule is code, not the model's opinion. Pure-function tests
// first (every check on its own), then real simulated cases.
import { describe, expect, it } from 'vitest';
import { runExperiment } from '../../src/agent/agent';
import { parseChanges } from '../../src/agent/changes';
import { compare, decide, findBottleneck, simulate, type Comparison, type Evidence } from '../../src/agent/evaluate';
import { DEFAULT_COSTS } from '../../src/agent/plan';
import { foodHeavyCafe, SIM, syntheticCafe } from './fixtures';

function comparison(base: number, cand: number, ciLow: number, extra: Partial<Comparison> = {}): Comparison {
  return {
    baseP90: base, candidateP90: cand, improvement: (base - cand) / base, candidateUnserved: 0,
    diff: { mean: base - cand, low: ciLow, high: base - cand + 1, n: 100 },
    byType: { drink: { baseP90: base, candidateP90: cand, change: (cand - base) / base } },
    timeInCafe: { baseP90: base + 2, candidateP90: cand + 2, change: (cand - base) / (base + 2) },
    ...extra,
  };
}
const good = (): Evidence => ({ nominal: comparison(10, 8, 1.5), faster: comparison(6, 5, 0.5), slower: comparison(15, 12, 2) });
const failed = (e: Evidence) => decide(e).checks.filter((c) => !c.passed).map((c) => c.name);

describe('decide() — each check on its own', () => {
  it('accepts when every check passes', () => {
    expect(decide(good()).accepted).toBe(true);
  });

  it('rejects an improvement under 10%', () => {
    expect(failed({ ...good(), nominal: comparison(10, 9.2, 0.3) })).toEqual(['Bad-case wait improves by at least 10%']);
  });

  it('rejects when the paired 95% CI includes zero', () => {
    expect(failed({ ...good(), nominal: comparison(10, 8, -0.2) })).toEqual(['Improvement is clear of simulation noise']);
  });

  it('rejects when it stops helping with tasks 30% faster', () => {
    expect(failed({ ...good(), faster: comparison(6, 6.3, -1) })).toEqual(['Still helps if tasks are 30% faster']);
  });

  it('rejects when it stops helping with tasks 30% slower', () => {
    expect(failed({ ...good(), slower: comparison(15, 16, -2) })).toEqual(['Still helps if tasks are 30% slower']);
  });

  it('rejects when any single order type gets more than 10% worse, even if overall improves', () => {
    const nominal = comparison(10, 8, 1.5, {
      byType: { drink: { baseP90: 4, candidateP90: 4.5, change: 0.125 }, food: { baseP90: 12, candidateP90: 8, change: -0.33 } },
    });
    expect(failed({ ...good(), nominal })).toEqual(['No order type gets more than 10% worse']);
  });

  it('allows an order type to get up to 10% worse', () => {
    const nominal = comparison(10, 8, 1.5, { byType: { drink: { baseP90: 4, candidateP90: 4.39, change: 0.0975 } } });
    expect(decide({ ...good(), nominal }).accepted).toBe(true);
  });

  it('rejects a plan that shortens the wait by keeping people longer in the order line', () => {
    const nominal = comparison(10, 6, 3, { timeInCafe: { baseP90: 40, candidateP90: 160, change: 3 } });
    expect(failed({ ...good(), nominal })).toEqual(['Time in café does not get more than 10% worse']);
  });

  it('rejects a plan that leaves orders unserved', () => {
    expect(failed({ ...good(), slower: { ...comparison(15, 12, 2), candidateUnserved: 3 } })).toEqual(['Every order gets served']);
  });
});

describe('acceptance on simulated cafés (SYNTHETIC)', () => {
  const cafe = syntheticCafe();
  const run = (c: typeof cafe, raw: unknown[]) => runExperiment(1, c, '', parseChanges(raw, c), {}, DEFAULT_COSTS, SIM);

  it('the barista is the bottleneck', () => {
    expect(findBottleneck(simulate(cafe, SIM).summary).station).toBe('barista');
  });

  it('accepts adding a barista (large, robust gain)', () => {
    const e = run(cafe, [{ kind: 'staff', station: 'barista', delta: 1 }]);
    expect(e.status).toBe('accepted');
    expect(e.evidence!.nominal.improvement).toBeGreaterThan(0.3);
  });

  it('rejects adding a cashier (not the bottleneck)', () => {
    expect(run(cafe, [{ kind: 'staff', station: 'cashier', delta: 1 }]).status).toBe('rejected');
  });

  it('rejects batching that helps but by less than 10%', () => {
    const e = run(cafe, [{ kind: 'foodBatching', intervalMin: 20, batchSize: 6 }]);
    expect(e.status).toBe('rejected');
    expect(e.decision!.checks.find((c) => !c.passed)!.name).toBe('Bad-case wait improves by at least 10%');
  });

  it('rejects moving a barista to the kitchen in a food-heavy café: overall p90 improves, drink-only waits get far worse', () => {
    const e = run(foodHeavyCafe(), [{ kind: 'staff', station: 'barista', delta: -1 }, { kind: 'staff', station: 'kitchen', delta: 1 }]);
    expect(e.evidence!.nominal.improvement).toBeGreaterThanOrEqual(0.1);
    expect(e.status).toBe('rejected');
    expect(e.decision!.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(['No order type gets more than 10% worse']);
  });

  it('blocks a plan that breaks a constraint without simulating it', () => {
    const e = runExperiment(1, cafe, '', parseChanges([{ kind: 'staff', station: 'barista', delta: 1 }], cafe), { noNewHires: true }, DEFAULT_COSTS, SIM);
    expect(e.status).toBe('blocked');
    expect(e.evidence).toBeUndefined();
  });

  it('compare() pairs replications: the same café against itself differs by exactly zero', () => {
    const c = compare(cafe, cafe, SIM);
    expect(c.diff.mean).toBe(0);
    expect(c.diff.low).toBe(0);
  });
});
