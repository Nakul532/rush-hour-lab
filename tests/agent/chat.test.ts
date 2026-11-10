// What-if chat and the model builder, with a scripted LLM.
import { describe, expect, it } from 'vitest';
import { LimitedLlm, LlmLimitError, MockLlm } from '../../src/agent/llm';
import { buildModelFromDescription, draftToSpec } from '../../src/agent/modelBuilder';
import { answerWhatIf } from '../../src/agent/whatIf';
import { SIM, syntheticCafe } from './fixtures';

describe('what-if chat', () => {
  const cafe = syntheticCafe();

  it('answers "add a barista 8–10" with numbers from code', async () => {
    const llm = new MockLlm([
      { toolCalls: [{ name: 'what_if', args: { changes: [{ kind: 'staff', station: 'barista', delta: 1, fromMin: 30, toMin: 90 }], explanation: 'Adds a barista for the busiest stretch.' } }] },
    ]);
    const r = await answerWhatIf(cafe, 'What if I add a barista from 8 to 10?', llm, SIM);
    expect(r.ok).toBe(true);
    expect(r.answer).toMatch(/^SIMULATED: Add 1 barista staff from 08:00 to 09:00\./);
    expect(r.answer).toContain(`${r.comparison!.baseP90.toFixed(1)} min to ${r.comparison!.candidateP90.toFixed(1)} min`);
    expect(r.answer).toMatch(/not a guarantee/);
    expect(r.explanation).toBe('Adds a barista for the busiest stretch.');
  });

  it("drops an explanation that contains the model's own numbers", async () => {
    const llm = new MockLlm([{ toolCalls: [{ name: 'what_if', args: { changes: [{ kind: 'grabGo', shareOfDrinks: 0.3 }], explanation: 'Saves about 4 minutes.' } }] }]);
    const r = await answerWhatIf(cafe, 'What if we sell drip coffee ready to go?', llm, SIM);
    expect(r.ok).toBe(true);
    expect(r.explanation).toBeNull();
  });

  it('retries once after an invalid change, then succeeds', async () => {
    const llm = new MockLlm([
      { toolCalls: [{ name: 'what_if', args: { changes: [{ kind: 'staff', station: 'drive-thru', delta: 1 }], explanation: 'x' } }] },
      { toolCalls: [{ name: 'what_if', args: { changes: [{ kind: 'staff', station: 'barista', delta: 1 }], explanation: 'Adds a barista.' } }] },
    ]);
    const r = await answerWhatIf(cafe, 'Add a drive-thru person?', llm, SIM);
    expect(r.ok).toBe(true);
    expect(r.llmCalls).toBe(2);
  });

  it('says plainly when a question cannot be simulated', async () => {
    const llm = new MockLlm([{ toolCalls: [{ name: 'what_if', args: { changes: [], explanation: 'Music volume is not something this simulator models.' } }] }]);
    const r = await answerWhatIf(cafe, 'What if I play louder music?', llm, SIM);
    expect(r.ok).toBe(false);
    expect(r.answer).toMatch(/not something this simulator models/);
  });

  it('shows a friendly message at the call limit (never an error)', async () => {
    const llm = new LimitedLlm(new MockLlm([]), { maxCalls: 0 });
    const r = await answerWhatIf(cafe, 'Add a barista?', llm, SIM);
    expect(r.ok).toBe(false);
    expect(r.answer).toMatch(/daily limit/);
  });
});

describe('model builder', () => {
  it('turns a description into a config and lists every assumption', async () => {
    const llm = new MockLlm([
      { toolCalls: [{ name: 'build_model', args: { staff: { cashier: 1, barista: 2 }, ordersPerHour: 40, minutes: { food: 6 }, startsAt: '07:00' } }] },
    ]);
    const r = await buildModelFromDescription('One cashier, two baristas, about 40 orders an hour from 7am, food is slow (6 minutes).', llm);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { spec, assumptions, confirmed } = r.model;
    expect(confirmed).toBe(false); // the user must confirm first
    expect(spec.staff).toEqual({ cashier: 1, barista: 2, kitchen: 1 });
    expect(spec.arrivals.ratePerMin.every((x) => Math.abs(x - 40 / 60) < 1e-12)).toBe(true);
    expect(spec.times.food).toEqual({ kind: 'lognormal', median: 6, sigma: 0.4 });
    expect(spec.startsAt).toBe('07:00');
    expect(assumptions.some((a) => a.startsWith('Kitchen staff: 1 (ASSUMPTION)'))).toBe(true);
    expect(assumptions.some((a) => a.includes('calibrated on 18 observed orders'))).toBe(true);
    expect(assumptions.some((a) => a.startsWith('Orders per hour'))).toBe(false);
  });

  it('no kitchen staff: food becomes ready items, and the café still serves every order', async () => {
    const m = draftToSpec({ staff: { cashier: 1, barista: 2, kitchen: 0 }, mixPercent: { drink: 60, food: 20, drinkFood: 20 } });
    expect(m.spec.mix).toEqual({ drink: 80, food: 0, drinkFood: 0, grabGo: 20 });
    expect(m.assumptions.some((a) => a.startsWith('No kitchen staff'))).toBe(true);
    const { simulate } = await import('../../src/agent/evaluate');
    expect(simulate(m.spec, { reps: 20, seed: 1 }).runs.every((r) => r.unserved === 0)).toBe(true);
  });

  it('no cashier: modelled as one order-taker, labelled as an assumption', () => {
    const m = draftToSpec({ staff: { cashier: 0, barista: 1, kitchen: 1 } });
    expect(m.spec.staff.cashier).toBe(1);
    expect(m.assumptions.some((a) => a.startsWith('No cashier'))).toBe(true);
  });

  it('replaces impossible values and says so', () => {
    const m = draftToSpec({ staff: { barista: -2 }, ordersPerHour: 100000 });
    expect(m.problems).toHaveLength(2);
    expect(m.spec.staff.barista).toBe(1);
  });

  it('retries after malformed JSON', async () => {
    const llm = new MockLlm([
      { toolCalls: [{ name: 'build_model', args: '{"staff": {' }] },
      { toolCalls: [{ name: 'build_model', args: { staff: { barista: 3 } } }] },
    ]);
    const r = await buildModelFromDescription('Three baristas.', llm);
    expect(r.ok && r.model.spec.staff.barista).toBe(3);
  });

  it('gives up politely if the model never complies', async () => {
    const r = await buildModelFromDescription('???', new MockLlm([{ content: 'Hello!' }], true));
    expect(r.ok).toBe(false);
  });

  it('limit errors are typed so the UI can show the friendly message', async () => {
    const llm = new LimitedLlm(new MockLlm([]), { maxCalls: 0 });
    await expect(llm.complete({ messages: [] })).rejects.toBeInstanceOf(LlmLimitError);
  });
});
