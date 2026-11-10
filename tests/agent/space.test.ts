import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../../src/agent/agent';
import { MockLlm } from '../../src/agent/llm';
import { choiceKey, enumerateChoices, matchPlan, spaceSize, type ChangeSpace } from '../../src/agent/space';
import { lastToolResult, SIM, syntheticCafe } from './fixtures';

const space: ChangeSpace = [
  { id: 'b', label: 'Barista', options: [{ label: '+1', changes: [{ kind: 'staff', station: 'barista', delta: 1 }] }, { label: 'peak', changes: [{ kind: 'staff', station: 'barista', delta: 1, fromMin: 30, toMin: 60 }] }] },
  { id: 'g', label: 'Grab', options: [{ label: '30%', changes: [{ kind: 'grabGo', shareOfDrinks: 0.3 }] }] },
];

describe('change space', () => {
  it('enumerates every plan once, including "no change"', () => {
    const all = [...enumerateChoices(space)].map(choiceKey);
    expect(all).toHaveLength(spaceSize(space));
    expect(new Set(all).size).toBe(6);
    expect(all).toContain('-1,-1');
  });

  it('maps a plan back to its choice, in any order', () => {
    expect(matchPlan(space, [{ kind: 'grabGo', shareOfDrinks: 0.3 }, { kind: 'staff', station: 'barista', delta: 1 }], syntheticCafe())).toEqual([0, 0]);
  });

  it('rejects plans outside the space', () => {
    expect(() => matchPlan(space, [{ kind: 'staff', station: 'kitchen', delta: 1 }], syntheticCafe())).toThrow(/Not one of the allowed options/);
  });

  it('the agent is held to the space by code', async () => {
    const llm = new MockLlm([
      { toolCalls: [{ name: 'test_change', args: { hypothesis: 'x', changes: [{ kind: 'staff', station: 'kitchen', delta: 1 }] } }] },
      (req) => {
        expect(String(lastToolResult(req.messages).error)).toMatch(/allowed options/);
        return { toolCalls: [{ name: 'finish', args: { summary: 'Done.' } }] };
      },
    ]);
    const r = await runAnalysis(syntheticCafe(), llm, { sim: SIM, changeSpace: space });
    expect(r.experiments).toHaveLength(0);
    expect(llm.requests[0].messages[1].content).toMatch(/Allowed options/);
  });
});
