import { describe, expect, it } from 'vitest';
import { buildSpace, peakWindow, recommend } from '../../src/agent/hybrid';
import { MockLlm } from '../../src/agent/llm';
import { spaceSize } from '../../src/agent/space';
import { observedCafePreset } from '../../src/presets/observedCafe';
import { syntheticCafe } from './fixtures';

const FAST = { searchSim: { reps: 60, seed: 1 }, verifySim: { reps: 200, seed: 2 } };

describe('change space for a café', () => {
  it('finds the busiest 30 minutes of the rush', () => {
    const cafe = syntheticCafe({ arrivals: { bucketMinutes: 15, ratePerMin: [0.2, 0.4, 0.9, 1.0, 0.5, 0.3] } });
    expect(peakWindow(cafe)).toEqual({ fromMin: 30, toMin: 60 });
  });

  it('under "no new hires" it offers moves, never hires', () => {
    const space = buildSpace(syntheticCafe({ staff: { cashier: 2, barista: 1, kitchen: 1 } }), { noNewHires: true });
    const all = space.flatMap((l) => l.options.flatMap((o) => o.changes));
    expect(all.some((c) => c.kind === 'dedicatedHandoff' || c.kind === 'expressDrinks')).toBe(false);
    expect(space.some((l) => l.options.some((o) => o.label === 'move one person from cashier to barista'))).toBe(true);
  });

  it('stays small enough to brute-force for typical cafés', () => {
    expect(spaceSize(buildSpace(syntheticCafe()))).toBeLessThanOrEqual(300);
    expect(spaceSize(buildSpace(observedCafePreset()))).toBeLessThanOrEqual(300);
  });
});

describe('hybrid recommender', () => {
  it('brute-forces, recommends the best plan, and re-checks it on a fresh seed', async () => {
    const r = await recommend(syntheticCafe(), FAST);
    expect(r.searchMethod).toBe('Brute force');
    expect(r.recommended).not.toBeNull();
    expect(r.recommended!.verification.passed).toBe(true);
    expect(r.recommended!.foundBy).toContain('Brute force');
    const best = Math.max(...r.plans.filter((p) => p.record.status === 'accepted').map((p) => p.record.evidence!.nominal.improvement));
    expect(r.recommended!.record.evidence!.nominal.improvement).toBe(best);
  });

  it('falls back to greedy search when brute force would be too slow', async () => {
    const r = await recommend(syntheticCafe(), { ...FAST, bruteForceBudget: 0 });
    expect(r.searchMethod).toBe('Greedy search');
    expect(r.recommended?.foundBy).toContain('Greedy search');
  });

  it('records which plans the LLM agent also found', async () => {
    const llm = new MockLlm([
      (req) => {
        // Pick the first option listed in the prompt's allowed-options block.
        const text = String(req.messages[1].content);
        const json = text.match(/= (\[\{.*?\}\])/)![1];
        return { toolCalls: [{ name: 'test_change', args: { hypothesis: 'Try the first option.', changes: JSON.parse(json) } }] };
      },
      { toolCalls: [{ name: 'finish', args: { summary: 'Tested one idea.' } }] },
    ]);
    const r = await recommend(syntheticCafe(), { ...FAST, llm });
    expect(r.agent.ran).toBe(true);
    expect(r.plans.some((p) => p.foundBy.includes('LLM agent') && p.foundBy.includes('Brute force'))).toBe(true);
  });

  it('respects constraints: no recommended plan breaks them', async () => {
    const r = await recommend(syntheticCafe({ staff: { cashier: 2, barista: 1, kitchen: 1 } }), { ...FAST, constraints: { noNewHires: true } });
    expect(r.recommended?.record.violations ?? []).toEqual([]);
  });

  it('runs on the observed café preset', async () => {
    const t0 = Date.now();
    const r = await recommend(observedCafePreset(), FAST);
    expect(r.plans.length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });
});
