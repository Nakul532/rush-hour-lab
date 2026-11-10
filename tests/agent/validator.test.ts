// Regression: a plan that leaves a station with no staff must be refused by
// every path. The bug appeared twice (an empty kitchen in Stage 2, an empty
// register in Stage 4), each time through a path that skipped the check.
// All paths now share validatePlan().
import { describe, expect, it } from 'vitest';
import { runAnalysis, runExperiment } from '../../src/agent/agent';
import { parseChanges, validatePlan, type Change } from '../../src/agent/changes';
import { runHeuristic } from '../../src/agent/heuristic';
import { recommend } from '../../src/agent/hybrid';
import { MockLlm } from '../../src/agent/llm';
import { DEFAULT_COSTS } from '../../src/agent/plan';
import { answerWhatIf } from '../../src/agent/whatIf';
import { evaluateChoice } from '../../eval/scoring';
import type { Scenario } from '../../eval/scenarios';
import { lastToolResult, SIM, syntheticCafe } from './fixtures';

const cafe = syntheticCafe(); // 1 cashier, 1 barista, 1 kitchen, starts 07:30
const emptyKitchen: Change[] = [{ kind: 'staff', station: 'kitchen', delta: -1 }, { kind: 'staff', station: 'barista', delta: 1 }];
const emptyBaristaMidRush: Change[] = [{ kind: 'staff', station: 'barista', delta: -1, fromMin: 30, toMin: 60 }];
const twoCashiers = syntheticCafe({ staff: { cashier: 2, barista: 1, kitchen: 1 } });
const emptyRegister: Change[] = [
  { kind: 'staff', station: 'cashier', delta: -1 }, { kind: 'staff', station: 'barista', delta: 1 },
  { kind: 'staff', station: 'cashier', delta: -1 }, { kind: 'staff', station: 'kitchen', delta: 1 },
];

describe('validatePlan (the shared validator)', () => {
  it('flags a station left empty for the whole rush', () => {
    expect(validatePlan(cafe, emptyKitchen)[0]).toMatch(/leaves kitchen with no staff for the whole rush/);
  });

  it('flags a station left empty for part of the rush ("during open hours"), with clock times', () => {
    expect(validatePlan(cafe, emptyBaristaMidRush)[0]).toMatch(/leaves barista with no staff from 08:00 to 08:30/);
  });

  it('flags an empty register reached by two moves that are each fine alone', () => {
    expect(validatePlan(twoCashiers, emptyRegister.slice(0, 2))).toEqual([]);
    expect(validatePlan(twoCashiers, emptyRegister)[0]).toMatch(/leaves cashier with no staff/);
  });

  it('does not flag an empty kitchen when nothing needs the kitchen', () => {
    const drinksOnly = syntheticCafe({ mix: { drink: 1, food: 0, drinkFood: 0 } });
    expect(validatePlan(drinksOnly, emptyKitchen)).toEqual([]);
  });
});

describe('every path refuses an empty station', () => {
  it('runExperiment (used by greedy, brute force, hybrid, baseline and eval): status invalid, never simulated', () => {
    for (const plan of [emptyKitchen, emptyBaristaMidRush]) {
      const e = runExperiment(1, cafe, '', plan, {}, DEFAULT_COSTS, SIM);
      expect(e.status).toBe('invalid');
      expect(e.evidence).toBeUndefined();
    }
  });

  it('parseChanges (LLM agent and what-if input)', () => {
    expect(() => parseChanges(emptyKitchen, cafe)).toThrow(/no staff/);
    expect(() => parseChanges(emptyBaristaMidRush, cafe)).toThrow(/no staff from 08:00 to 08:30/);
  });

  it('LLM agent: the plan is refused with a message the model can act on, and no experiment is recorded', async () => {
    const llm = new MockLlm([
      { toolCalls: [{ name: 'test_change', args: { hypothesis: 'Move the cook to drinks.', changes: emptyKitchen } }] },
      (req) => {
        expect(String(lastToolResult(req.messages).error)).toMatch(/no staff/);
        return { toolCalls: [{ name: 'finish', args: { summary: 'Done.' } }] };
      },
    ]);
    const r = await runAnalysis(cafe, llm, { sim: SIM });
    expect(r.experiments).toHaveLength(0);
  });

  it('what-if: the question is not answered with an impossible café', async () => {
    const bad = { toolCalls: [{ name: 'what_if', args: { changes: emptyBaristaMidRush, explanation: 'Send the barista on a break.' } }] };
    const r = await answerWhatIf(cafe, 'What if the barista takes a break at 8?', new MockLlm([bad, bad]), SIM);
    expect(r.ok).toBe(false);
    expect(r.comparison).toBeNull();
  });

  for (const [name, budget] of [['brute force', undefined], ['greedy', 0]] as const) {
    it(`hybrid ${name}: the two-move empty register is marked invalid, and nothing invalid is recommended`, async () => {
      const r = await recommend(twoCashiers, {
        constraints: { noNewHires: true, maxChanges: 4 },
        searchSim: { reps: 40, seed: 1 },
        verifySim: { reps: 100, seed: 2 },
        bruteForceBudget: budget,
      });
      for (const p of r.plans) if (p.record.status === 'accepted' || p.record.status === 'rejected') expect(validatePlan(twoCashiers, p.record.changes)).toEqual([]);
      if (r.recommended) expect(validatePlan(twoCashiers, r.recommended.record.changes)).toEqual([]);
      const both = r.plans.find((p) => /cashier to barista/.test(p.label) && /cashier to kitchen/.test(p.label));
      if (name === 'brute force') expect(both?.record.status).toBe('invalid');
      else if (both) expect(both.record.status).toBe('invalid');
    });
  }

  it('rule-based baseline: every plan it tests is valid', () => {
    const r = runHeuristic(twoCashiers, { sim: SIM, constraints: { noNewHires: true } });
    for (const e of r.experiments) expect(e.status === 'invalid' || validatePlan(twoCashiers, e.changes).length === 0).toBe(true);
  });

  it('evaluation scoring (brute-force ground truth): the plan is scored as invalid', () => {
    const s: Scenario = {
      id: 'T', title: 'test', why: 'test', provenance: 'SYNTHETIC', spec: twoCashiers, constraints: {},
      space: [
        { id: 'a', label: 'a', options: [{ label: 'cashier → barista', changes: emptyRegister.slice(0, 2) }] },
        { id: 'b', label: 'b', options: [{ label: 'cashier → kitchen', changes: emptyRegister.slice(2) }] },
      ],
    };
    expect(evaluateChoice(s, [0, 0]).status).toBe('invalid');
    expect(evaluateChoice(s, [0, -1]).status).not.toBe('invalid');
  });
});
