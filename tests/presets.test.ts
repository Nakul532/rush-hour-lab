import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../src/agent/agent';
import { simulate } from '../src/agent/evaluate';
import { MockLlm } from '../src/agent/llm';
import { CURIO_REPORTED_WAIT, curioPreset } from '../src/presets/curio';
import { PRESETS } from '../src/presets';

describe('presets', () => {
  it('the observed café is the primary example and comes first', () => {
    expect(PRESETS[0].id).toBe('observed');
    expect(PRESETS.filter((p) => p.primary).map((p) => p.id)).toEqual(['observed']);
  });

  it('Curio carries both required labels', () => {
    const curio = PRESETS.find((p) => p.id === 'curio')!;
    expect(curio.labels).toContain('Reconstructed from a 2025 class proposal; original figures were inconsistent');
    expect(curio.labels).toContain('Based on a 2025 Lean proposal; recommendations were not implemented');
  });

  it('Curio: simulated median wait is inside the 8–12 min staff reported, and every order is served', () => {
    const { summary, runs } = simulate(curioPreset(), { reps: 200, seed: 20261109 });
    expect(summary.overall.median.mean).toBeGreaterThanOrEqual(CURIO_REPORTED_WAIT.low);
    expect(summary.overall.median.mean).toBeLessThanOrEqual(CURIO_REPORTED_WAIT.high);
    expect(runs.every((r) => r.unserved === 0)).toBe(true);
  });

  it('the agent runs on Curio (mock LLM): parallel prep, one of the proposal\'s own ideas', async () => {
    const llm = new MockLlm([
      { toolCalls: [{ name: 'test_change', args: { hypothesis: 'Make drinks and waffles at the same time.', changes: [{ kind: 'prepMode', mode: 'parallel' }] } }] },
      { toolCalls: [{ name: 'finish', args: { summary: 'Tested parallel prep.' } }] },
    ]);
    const r = await runAnalysis(curioPreset(), llm, { sim: { reps: 100, seed: 1 } });
    expect(r.experiments).toHaveLength(1);
    expect(r.experiments[0].evidence).toBeDefined();
  });
});
