import { describe, expect, it } from 'vitest';
import { runExperiment } from '../../src/agent/agent';
import { verdict } from '../../src/agent/explain';
import { DEFAULT_COSTS } from '../../src/agent/plan';
import { foodHeavyCafe, SIM, syntheticCafe } from './fixtures';

const run = (c: ReturnType<typeof syntheticCafe>, changes: Parameters<typeof runExperiment>[3], constraints = {}) =>
  runExperiment(1, c, '', changes, constraints, DEFAULT_COSTS, SIM);

describe('plain-sentence verdicts', () => {
  it('a plan that makes waits worse says by how much', () => {
    const v = verdict(run(syntheticCafe(), [{ kind: 'staff', station: 'cashier', delta: 1 }]));
    expect(v.kind).toBe('rejected');
    expect(v.sentence).toMatch(/^✗ Rejected: bad-case wait got \d+% longer/);
  });

  it('a plan that helps too little says so, with the bar', () => {
    const v = verdict(run(syntheticCafe(), [{ kind: 'foodBatching', intervalMin: 20, batchSize: 6 }]));
    expect(v.sentence).toMatch(/only \d+\.\d% shorter \(needs 10%\)/);
  });

  it('names the order type that got worse', () => {
    const v = verdict(run(foodHeavyCafe(), [{ kind: 'staff', station: 'barista', delta: -1 }, { kind: 'staff', station: 'kitchen', delta: 1 }]));
    expect(v.sentence).toMatch(/^✗ Rejected: drink only waits got \d+% longer\.$/);
  });

  it('a constraint break says which limit', () => {
    const v = verdict(run(syntheticCafe(), [{ kind: 'staff', station: 'barista', delta: 1 }], { noNewHires: true }));
    expect(v.sentence).toBe('✗ Not allowed: needs 1 more person on shift than you have today (your limit: no new hires).');
  });

  it('an impossible plan says why', () => {
    const v = verdict(run(syntheticCafe(), [{ kind: 'staff', station: 'kitchen', delta: -1 }]));
    expect(v.sentence).toMatch(/^✗ Not possible: the plan leaves kitchen with no staff/);
  });

  it('a passing plan that is not the best says so', () => {
    expect(verdict(run(syntheticCafe(), [{ kind: 'staff', station: 'barista', delta: 1 }])).sentence).toMatch(/^✓ Passed every check, but/);
  });
});
