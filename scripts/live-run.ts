// npm run live-run -- --live
//
// One-off live test of the agent against Groq (gpt-oss-120b), capped at
// 40,000 tokens in total so the shared Groq quota keeps headroom for
// SearchIQ's live site.
//
//  1. Runs analysis 1 (observed café).
//  2. Runs analysis 2, then 3, only if the tokens left exceed 1.25× the most
//     any analysis has used so far.
//  3. No single call starts unless its worst case fits in what is left.
//
// Every request/response is saved to tests/fixtures/live/ so the mocked
// tests can replay real model output. The key is read from GROQ_API_KEY or
// a git-ignored .env.local, and never printed or saved.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runAnalysis, type AnalysisResult } from '../src/agent/agent';
import { GroqLlm, GROQ_MODEL } from '../src/agent/groq';
import { LimitedLlm, RecordingLlm, TokenBudget } from '../src/agent/llm';
import { buildModelFromDescription } from '../src/agent/modelBuilder';
import { answerWhatIf } from '../src/agent/whatIf';
import { constantCurve } from '../src/sim/arrivals';
import { lognormal } from '../src/sim/distributions';
import type { CafeSpec } from '../src/sim/cafe';
import { observedCafePreset } from '../src/presets/observedCafe';

const TOKEN_CAP = 40_000;
const HEADROOM = 1.25;
const SIM = { reps: 300, seed: 20261109 };
const AGENT_LIMITS = { maxLlmCalls: 10, maxExperiments: 4, maxTokensPerCall: 1024 };

if (!process.argv.includes('--live')) {
  console.log('Refusing to call Groq without --live. Usage: npm run live-run -- --live');
  process.exit(1);
}

function loadKey(): string {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  if (existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^\s*GROQ_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/);
      if (m) return m[1];
    }
  }
  console.log('No GROQ_API_KEY found (environment or .env.local). Nothing was sent.');
  process.exit(1);
}

// SYNTHETIC café for analysis 2 (not real data).
const synthetic: CafeSpec = {
  name: 'Synthetic test café',
  arrivals: constantCurve(0.6, 90),
  mix: { drink: 50, food: 20, drinkFood: 30 },
  staff: { cashier: 2, barista: 1, kitchen: 1 },
  times: { order: lognormal(0.8, 0.4), drink: lognormal(1.3, 0.4), food: lognormal(2.5, 0.4), handoff: lognormal(0.3, 0.4) },
  prepMode: 'parallel',
  handoff: 'barista',
  startsAt: '07:30',
};

const budget = new TokenBudget(TOKEN_CAP);
const groq = new GroqLlm({ apiKey: loadKey(), reasoningEffort: 'low' });
const log: Array<Record<string, unknown>> = [];
let maxUsed = 0;

async function analysis(n: number, name: string, run: (llm: LimitedLlm) => Promise<Record<string, unknown>>) {
  if (n > 1 && budget.remaining < maxUsed * HEADROOM) {
    console.log(`[live] skip analysis ${n} (${name}): ${budget.remaining} tokens left, need ~${Math.round(maxUsed * HEADROOM)}`);
    log.push({ n, name, skipped: true, remaining: budget.remaining });
    return;
  }
  const rec = new RecordingLlm(groq);
  const llm = new LimitedLlm(rec, { budget, estimatePerCall: true });
  const before = budget.used;
  const t0 = Date.now();
  let outcome: Record<string, unknown>;
  try {
    outcome = await run(llm);
  } catch (err) {
    outcome = { error: err instanceof Error ? err.message : String(err) };
  }
  const used = budget.used - before;
  maxUsed = Math.max(maxUsed, used);
  console.log(`[live] analysis ${n} (${name}): ${llm.calls} calls, ${used} tokens, ${((Date.now() - t0) / 1000).toFixed(0)} s; ${budget.remaining} left`);
  log.push({ n, name, calls: llm.calls, tokens: used, outcome });
  mkdirSync('tests/fixtures/live', { recursive: true });
  writeFileSync(`tests/fixtures/live/analysis-${n}.json`, JSON.stringify({ model: GROQ_MODEL, name, calls: rec.log }, null, 2) + '\n');
}

const summarize = (r: AnalysisResult) => ({
  stopReason: r.stopReason,
  experiments: r.experiments.map((e) => ({ status: e.status, changes: e.descriptions, hypothesis: e.hypothesis, failed: e.decision?.checks.filter((c) => !c.passed).map((c) => c.name) ?? e.violations })),
  recommended: r.recommended?.descriptions ?? null,
  improvementPct: r.recommended ? Math.round(r.recommended.evidence!.nominal.improvement * 1000) / 10 : null,
  summary: r.summary,
  errors: r.steps.filter((s) => s.kind === 'error').map((s) => (s as { message: string }).message),
});

await analysis(1, 'Observed café, max 2 changes', async (llm) => summarize(await runAnalysis(observedCafePreset(), llm, { ...AGENT_LIMITS, sim: SIM, constraints: { maxChanges: 2 } })));
await analysis(2, 'Synthetic café, no new hires, $500 budget', async (llm) =>
  summarize(await runAnalysis(synthetic, llm, { ...AGENT_LIMITS, sim: SIM, constraints: { noNewHires: true, budgetUsd: 500 } })));
await analysis(3, 'Model builder + what-if', async (llm) => {
  const built = await buildModelFromDescription(
    'Small café, open 7am. One cashier, two baristas, one person on the waffle iron. About 45 orders an hour in the morning rush, which lasts two hours. Waffles take about 6 minutes. Drinks and waffles are made at the same time.',
    llm,
  );
  if (!built.ok) return { built: false, message: built.message };
  const whatIf = await answerWhatIf(built.model.spec, 'What if I add a second person on the waffle iron from 8 to 9?', llm, SIM);
  return { built: true, staff: built.model.spec.staff, assumptions: built.model.assumptions, whatIf: { ok: whatIf.ok, answer: whatIf.answer, explanation: whatIf.explanation } };
});

writeFileSync(
  'tests/fixtures/live/RESULTS.json',
  JSON.stringify({ model: GROQ_MODEL, tokenCap: TOKEN_CAP, tokensUsed: budget.used, ranAt: new Date().toISOString(), analyses: log }, null, 2) + '\n',
);
console.log(`[live] done: ${budget.used} of ${TOKEN_CAP} tokens used. Results in tests/fixtures/live/.`);
