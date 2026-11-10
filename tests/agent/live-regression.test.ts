// Regressions found by the first live run (gpt-oss-120b via OpenRouter → Groq).
// The model followed the tool schema strictly. The schema declared only
// `kind`, so it sent {"kind":"staff"} ten times in a row. Mocks never caught
// this because they always sent complete arguments.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_REPEATED_ERRORS, runAnalysis } from '../../src/agent/agent';
import { parseChange } from '../../src/agent/changes';
import { MockLlm, type MockTurn } from '../../src/agent/llm';
import { CHANGE_SCHEMA } from '../../src/agent/prompts';
import { observedCafePreset } from '../../src/presets/observedCafe';
import { SIM, syntheticCafe } from './fixtures';

const FIRST_LIVE_RUN = 'tests/fixtures/live/first-run-schema-bug.json';

describe('tool schema matches what the code reads', () => {
  const declared = Object.keys(CHANGE_SCHEMA.properties);

  it.each([
    ['staff', { station: 'barista', delta: 1, fromMin: 0, toMin: 30 }],
    ['prepMode', { mode: 'parallel' }],
    ['foodBatching', { intervalMin: 15, batchSize: 4, cookMin: 3 }],
    ['dedicatedHandoff', { staff: 1 }],
    ['expressDrinks', { staff: 1 }],
    ['grabGo', { shareOfDrinks: 0.3 }],
  ])('every field of a %s change is declared in the schema', (kind, fields) => {
    for (const f of Object.keys(fields)) expect(declared).toContain(f);
    expect(() => parseChange({ kind, ...fields }, syntheticCafe())).not.toThrow();
  });

  it('the schema does not allow undeclared fields', () => {
    expect(CHANGE_SCHEMA.additionalProperties).toBe(false);
  });

  it('a staff change without station/delta gets an error that names the missing fields', () => {
    expect(() => parseChange({ kind: 'staff' }, syntheticCafe())).toThrow(/needs "station".*and "delta"/);
  });
});

describe('replay of the first live run', () => {
  const fixture = JSON.parse(readFileSync(FIRST_LIVE_RUN, 'utf8')) as {
    calls: Array<{ response: { message: { tool_calls?: Array<{ function: { name: string; arguments: string } }> } } }>;
  };
  const script: MockTurn[] = fixture.calls.map((c) => ({
    toolCalls: (c.response.message.tool_calls ?? []).map((t) => ({ name: t.function.name, args: t.function.arguments })),
  }));

  it('the recorded model output is the incomplete staff change', () => {
    expect(script[0].toolCalls![0].args).toBe('{"changes":[{"kind":"staff"}],"hypothesis":"adding a kitchen staff reduces kitchen bottleneck and lowers p90"}');
  });

  it(`now stops after ${MAX_REPEATED_ERRORS} identical failures instead of burning all 10 calls`, async () => {
    const r = await runAnalysis(observedCafePreset(), new MockLlm(script), { sim: SIM, maxLlmCalls: 10 });
    expect(r.stopReason).toBe('repeated_error');
    expect(r.llmCalls).toBe(MAX_REPEATED_ERRORS);
  });
});
