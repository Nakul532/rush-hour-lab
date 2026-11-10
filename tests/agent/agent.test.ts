// The experiment loop, driven by a scripted (mock) LLM. No network.
import { describe, expect, it } from 'vitest';
import { MAX_LLM_CALLS, numberFree, runAnalysis } from '../../src/agent/agent';
import { runHeuristic } from '../../src/agent/heuristic';
import { LimitedLlm, MockLlm, TokenBudget, type LlmRequest } from '../../src/agent/llm';
import { observedCafePreset } from '../../src/presets/observedCafe';
import { lastToolResult, SIM, syntheticCafe } from './fixtures';

const addBarista = [{ kind: 'staff', station: 'barista', delta: 1 }];
const handoff = [{ kind: 'dedicatedHandoff', staff: 1 }];

describe('experiment loop (mock LLM)', () => {
  it('runs hypothesis → test → learn → test → finish, and code picks the recommendation', async () => {
    let sawFirstResult: Record<string, unknown> = {};
    const llm = new MockLlm([
      { toolCalls: [{ name: 'find_bottleneck', args: { changes: [] } }] },
      { toolCalls: [{ name: 'test_change', args: { hypothesis: 'The barista is the bottleneck.', changes: addBarista } }] },
      (req: LlmRequest) => {
        sawFirstResult = lastToolResult(req.messages);
        return { toolCalls: [{ name: 'test_change', args: { hypothesis: 'A cheaper idea: a handoff point.', changes: handoff } }] };
      },
      { toolCalls: [{ name: 'test_change', args: { hypothesis: 'Cashier is not busy.', changes: [{ kind: 'staff', station: 'cashier', delta: 1 }] } }] },
      { toolCalls: [{ name: 'finish', args: { summary: 'Adding barista capacity helps most. A cashier does not.' } }] },
    ]);
    const r = await runAnalysis(syntheticCafe(), llm, { sim: SIM });
    expect(r.stopReason).toBe('finished');
    expect(r.llmCalls).toBe(5);
    expect(sawFirstResult.status).toBe('accepted'); // the LLM is shown each experiment's result
    expect(r.experiments.map((e) => e.status)).toEqual(['accepted', 'accepted', 'rejected']);
    expect(r.recommended?.descriptions).toEqual(['Add 1 barista staff for the whole rush']);
    expect(r.summary).toBe('Adding barista capacity helps most. A cashier does not.');
    expect(r.steps.at(-1)).toMatchObject({ kind: 'stop', reason: 'finished' });
  });

  it('the first prompt includes the café, constraints and baseline results', async () => {
    const llm = new MockLlm([{ toolCalls: [{ name: 'finish', args: { summary: 'Nothing to test.' } }] }]);
    await runAnalysis(syntheticCafe(), llm, { sim: SIM, constraints: { noNewHires: true, maxChanges: 2 } });
    const user = llm.requests[0].messages[1].content as string;
    expect(user).toMatch(/No new hires/);
    expect(user).toMatch(/At most 2 changes/);
    expect(user).toMatch(/Busiest station: barista/);
  });

  it('respects constraints: a hire under "no new hires" is blocked and still uses an experiment', async () => {
    const llm = new MockLlm([
      { toolCalls: [{ name: 'test_change', args: { hypothesis: 'Hire a barista.', changes: addBarista } }] },
      (req) => {
        expect(lastToolResult(req.messages).status).toBe('blocked');
        return { toolCalls: [{ name: 'finish', args: { summary: 'Hiring is not allowed.' } }] };
      },
    ]);
    const r = await runAnalysis(syntheticCafe(), llm, { sim: SIM, constraints: { noNewHires: true } });
    expect(r.experiments[0].status).toBe('blocked');
    expect(r.recommended).toBeNull();
  });

  it('hard stop at the experiment budget', async () => {
    const llm = new MockLlm([{ toolCalls: [{ name: 'test_change', args: { hypothesis: 'Try again.', changes: addBarista } }] }], true);
    const r = await runAnalysis(syntheticCafe(), llm, { sim: SIM, maxExperiments: 3 });
    expect(r.stopReason).toBe('experiment_budget');
    expect(r.experiments).toHaveLength(3);
    expect(llm.requests).toHaveLength(3);
  });

  it(`hard stop at ${MAX_LLM_CALLS} LLM calls, and the cap cannot be raised`, async () => {
    const llm = new MockLlm([{ toolCalls: [{ name: 'run_simulation', args: { changes: [] } }] }], true);
    const r = await runAnalysis(syntheticCafe(), llm, { sim: { reps: 20, seed: 1 }, maxLlmCalls: 99, maxSimulations: 100 });
    expect(r.stopReason).toBe('llm_call_limit');
    expect(r.llmCalls).toBe(MAX_LLM_CALLS);
  });

  it('stops cleanly when the shared token budget runs low', async () => {
    const budget = new TokenBudget(3000);
    const inner = new MockLlm([{ toolCalls: [{ name: 'run_simulation', args: { changes: [] } }] }], true);
    // Per-call worst-case estimate (what the live run uses): the budget must never go negative.
    const llm = new LimitedLlm(inner, { budget, estimatePerCall: true });
    const r = await runAnalysis(syntheticCafe(), llm, { sim: { reps: 20, seed: 1 } });
    expect(r.stopReason).toBe('token_budget');
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
  });

  describe('bad model output is handled, never trusted', () => {
    const recover = (bad: { name: string; args: unknown }) =>
      new MockLlm([
        { toolCalls: [bad] },
        (req) => {
          expect(lastToolResult(req.messages).error).toBeTypeOf('string');
          return { toolCalls: [{ name: 'finish', args: { summary: 'Done.' } }] };
        },
      ]);

    it('invalid JSON arguments', async () => {
      const r = await runAnalysis(syntheticCafe(), recover({ name: 'test_change', args: '{"changes": [oops' }), { sim: SIM });
      expect(r.stopReason).toBe('finished');
      expect(r.steps.some((s) => s.kind === 'error' && /valid JSON/.test(s.message))).toBe(true);
    });

    it('an unknown tool', async () => {
      const r = await runAnalysis(syntheticCafe(), recover({ name: 'hire_consultant', args: {} }), { sim: SIM });
      expect(r.steps.some((s) => s.kind === 'error' && /Unknown tool/.test(s.message))).toBe(true);
    });

    it('a station that does not exist', async () => {
      const r = await runAnalysis(syntheticCafe(), recover({ name: 'test_change', args: { hypothesis: 'x', changes: [{ kind: 'staff', station: 'drive-thru', delta: 1 }] } }), { sim: SIM });
      expect(r.experiments).toHaveLength(0);
      expect(r.steps.some((s) => s.kind === 'error' && /Unknown station/.test(s.message))).toBe(true);
    });

    it('made-up numbers in the closing summary are dropped', async () => {
      const llm = new MockLlm([{ toolCalls: [{ name: 'finish', args: { summary: 'This will cut waits by 45%.' } }] }]);
      const r = await runAnalysis(syntheticCafe(), llm, { sim: SIM });
      expect(r.summary).toBeNull();
    });

    it('an empty reply (no text, no tool call) is retried and the run continues', async () => {
      const llm = new MockLlm([
        {},
        {},
        { toolCalls: [{ name: 'test_change', args: { hypothesis: 'More barista.', changes: addBarista } }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'Done.' } }] },
      ]);
      const r = await runAnalysis(syntheticCafe(), llm, { sim: SIM });
      expect(r.stopReason).toBe('finished');
      expect(r.emptyRetries).toBe(2);
      expect(r.experiments).toHaveLength(1);
      // Retries resend the same history: the empty replies are not added to it.
      expect(llm.requests[2].messages).toHaveLength(llm.requests[0].messages.length);
    });

    it('after two failed retries the empty reply counts as a silent turn', async () => {
      const llm = new MockLlm([{}], true);
      const r = await runAnalysis(syntheticCafe(), llm, { sim: SIM });
      expect(r.stopReason).toBe('no_tool_call');
      expect(r.llmCalls).toBe(6); // (1 + 2 retries) × 2 silent turns
    });

    it('replies without a tool call: nudged once, then stopped', async () => {
      const llm = new MockLlm([{ content: 'I think you should hire.' }], true);
      const r = await runAnalysis(syntheticCafe(), llm, { sim: SIM });
      expect(r.stopReason).toBe('no_tool_call');
      expect(r.llmCalls).toBe(2);
    });

    it('several tool calls in one turn: only the first runs', async () => {
      const llm = new MockLlm([
        { toolCalls: [{ name: 'test_change', args: { hypothesis: 'a', changes: addBarista } }, { name: 'test_change', args: { hypothesis: 'b', changes: handoff } }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'Done.' } }] },
      ]);
      const r = await runAnalysis(syntheticCafe(), llm, { sim: SIM });
      expect(r.experiments).toHaveLength(1);
    });
  });

  it('runs on the calibrated observed-café preset', async () => {
    const llm = new MockLlm([
      { toolCalls: [{ name: 'test_change', args: { hypothesis: 'Make drinks and food at once.', changes: [{ kind: 'prepMode', mode: 'parallel' }] } }] },
      { toolCalls: [{ name: 'finish', args: { summary: 'Tested parallel prep.' } }] },
    ]);
    const r = await runAnalysis(observedCafePreset(), llm, { sim: SIM });
    expect(r.experiments).toHaveLength(1);
    expect(['accepted', 'rejected']).toContain(r.experiments[0].status);
    expect(r.baseline.provenance).toBe('SIMULATED');
  });
});

describe('numberFree', () => {
  it('keeps text without digits and drops text with them', () => {
    expect(numberFree('Add a barista.')).toBe('Add a barista.');
    expect(numberFree('Cuts waits 3 min')).toBeNull();
    expect(numberFree('The p90 wait improves.')).toBe('The p90 wait improves.');
    expect(numberFree('The p90 wait improves 20%.')).toBeNull();
  });
});

describe('rule-based baseline agent', () => {
  it('relieves the bottleneck and stops when nothing else earns its place', () => {
    const r = runHeuristic(syntheticCafe(), { sim: SIM });
    expect(r.recommended?.descriptions[0]).toBe('Add 1 barista staff for the whole rush');
    for (const e of r.experiments) expect(e.changes.length).toBeLessThanOrEqual(3);
  });

  it('under "no new hires" it only moves people', () => {
    const r = runHeuristic(syntheticCafe({ staff: { cashier: 2, barista: 1, kitchen: 1 } }), { sim: SIM, constraints: { noNewHires: true } });
    expect(r.recommended).not.toBeNull();
    expect(r.experiments.every((e) => e.violations.length === 0)).toBe(true);
  });
});

describe('tool name normalisation', () => {
  it('accepts "functions.finish" and "name=functions.finish"', async () => {
    const { normalizeToolName } = await import('../../src/agent/agent');
    expect(normalizeToolName('name=functions.finish')).toBe('finish');
    expect(normalizeToolName('functions.test_change')).toBe('test_change');
    expect(normalizeToolName('finish')).toBe('finish');
  });
});
