// npm run eval -- <phase>     phases: truth | greedy | agent | fresh | builder | all
// Results go to eval/results/. LLM phases (agent, builder) need --live.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runAnalysis } from '../src/agent/agent';
import { simulate, simulationCounter } from '../src/agent/evaluate';
import { LimitedLlm, RecordingLlm, TokenBudget } from '../src/agent/llm';
import { buildModelFromDescription, type CafeDraft } from '../src/agent/modelBuilder';
import { loadEnvKey, OpenRouterLlm, OPENROUTER_MODEL, PINNED_PROVIDER } from '../src/agent/openrouter';
import { choiceKey, type Choice } from '../src/agent/space';
import { BUILDER_CASES, BUILDER_HELDOUT } from './modelBuilderCases';
import { SCENARIOS as ORIGINAL } from './scenarios';
import { INTERACTING } from './scenariosInteracting';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
/** --set original | interacting */
const SCENARIOS = arg('--set') === 'interacting' ? INTERACTING : ORIGINAL;
import {
  agentRecommendationKey, allChoices, EVAL_SIM, evaluateChoice, freshCheck, pickOptimal, scoreBuilder, scoreRecommendation,
  type BuilderScore, type GroundTruth, type PlanRow, type SearcherScore,
} from './scoring';

/** --out <dir>: keeps post-lock runs apart from the original results. */
const DIR = arg('--out') ?? 'eval/results';
const SPEND_CAP_USD = 1.0;
const TOKEN_CAP = 600_000;
/** Per-call cost fields under-reported account usage ~6.5× in the live test; budget against the higher figure. */
const COST_SAFETY = 7;

mkdirSync(DIR, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(`${DIR}/${name}`, JSON.stringify(data, null, 2) + '\n');
const load = <T>(name: string): T => JSON.parse(readFileSync(`${DIR}/${name}`, 'utf8')) as T;
const log = (m: string) => console.log(`[eval] ${m}`);
const phase = process.argv[2] ?? 'all';
const live = process.argv.includes('--live');
const SIMS_PER_PLAN = 6; // acceptance rule: today + plan, at normal, −30% and +30% task times

// ---------------------------------------------------------------- brute force
function truth() {
  const out: GroundTruth[] = [];
  for (const s of SCENARIOS) {
    const t0 = Date.now();
    const baseP90 = simulate(s.spec, EVAL_SIM).summary.overall.p90.mean;
    simulationCounter.count = 0;
    const plans = allChoices(s).map((c) => evaluateChoice(s, c));
    const gt: GroundTruth = { scenario: s.id, plans, baseP90, optimal: pickOptimal(plans), simulations: simulationCounter.count };
    out.push(gt);
    log(`${s.id}: ${plans.length} plans, ${plans.filter((p) => p.status === 'accepted').length} accepted, optimal: ${gt.optimal?.label ?? 'nothing'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  save('ground-truth.json', out);
}

// ---------------------------------------------------------------- greedy
function greedy() {
  const gts = load<GroundTruth[]>('ground-truth.json');
  const scores: SearcherScore[] = [];
  for (const s of SCENARIOS) {
    const gt = gts.find((g) => g.scenario === s.id)!;
    const table = new Map(gt.plans.map((p) => [p.key, p]));
    let current: Choice = s.space.map(() => -1);
    let best: PlanRow | null = null;
    let sims = 0;
    let experiments = 0;
    const tried = new Set<string>();
    const accepted = new Set<string>();
    for (;;) {
      let roundBest: { choice: Choice; row: PlanRow } | null = null;
      s.space.forEach((lever, i) => {
        if (current[i] >= 0) return;
        lever.options.forEach((_, j) => {
          const choice = [...current];
          choice[i] = j;
          const key = choiceKey(choice);
          const row = table.get(key)!;
          if (!tried.has(key)) {
            tried.add(key);
            experiments++;
            if (row.status === 'accepted' || row.status === 'rejected') sims += SIMS_PER_PLAN;
            if (row.status === 'accepted') accepted.add(key);
          }
          if (row.status === 'accepted' && (!roundBest || row.improvement! > roundBest.row.improvement!)) roundBest = { choice, row };
        });
      });
      const rb = roundBest as { choice: Choice; row: PlanRow } | null;
      if (!rb || (best && rb.row.improvement! <= best.improvement!)) break;
      current = rb.choice;
      best = rb.row;
    }
    scores.push(scoreRecommendation('greedy', gt, best?.key ?? null, sims, experiments, accepted.size));
  }
  save('greedy.json', scores);
  log(`greedy: optimal ${scores.filter((x) => x.foundOptimal).length}/${scores.length}, within 5% ${scores.filter((x) => x.within5).length}/${scores.length}`);
}

// ---------------------------------------------------------------- LLM agent
async function agent() {
  if (!live) throw new Error('The agent phase calls the LLM; pass --live');
  const key = await loadEnvKey('OPENROUTER_API_KEY');
  if (!key) throw new Error('OPENROUTER_API_KEY not found');
  const gts = load<GroundTruth[]>('ground-truth.json');
  const llmClient = new OpenRouterLlm({ apiKey: key, reasoningEffort: 'low' });
  const startCredits = await llmClient.credits();
  const budget = new TokenBudget(TOKEN_CAP);
  const scores: SearcherScore[] = [];
  const runs: unknown[] = [];
  mkdirSync(`${DIR}/agent-transcripts`, { recursive: true });
  for (const s of SCENARIOS) {
    const keyDelta = (await llmClient.credits()).usage - startCredits.usage;
    const spent = Math.max(keyDelta, llmClient.costUsd * COST_SAFETY);
    if (spent >= SPEND_CAP_USD) {
      log(`${s.id}: not run (spend ~$${spent.toFixed(3)} reached the $${SPEND_CAP_USD} cap)`);
      scores.push({ ...scoreRecommendation('llm-agent', gts.find((g) => g.scenario === s.id)!, null, 0, 0, 0), notes: ['not run: spending cap'] });
      continue;
    }
    const rec = new RecordingLlm(llmClient);
    const llm = new LimitedLlm(rec, { budget, estimatePerCall: true });
    simulationCounter.count = 0;
    const t0 = Date.now();
    const r = await runAnalysis(s.spec, llm, { constraints: s.constraints, sim: EVAL_SIM, maxExperiments: 6, maxLlmCalls: 12, changeSpace: s.space });
    const gt = gts.find((g) => g.scenario === s.id)!;
    const notes: string[] = [`stop: ${r.stopReason}`, `${r.llmCalls} LLM calls, ${r.tokens} tokens`];
    let recKey: string | null = null;
    try {
      recKey = agentRecommendationKey(s, r);
    } catch (err) {
      notes.push(`recommendation outside space: ${(err as Error).message}`);
    }
    const accepted = r.experiments.filter((e) => e.status === 'accepted').length;
    const score = scoreRecommendation('llm-agent', gt, recKey, simulationCounter.count, r.experiments.length, accepted, notes);
    scores.push(score);
    runs.push({ scenario: s.id, stopReason: r.stopReason, emptyRetries: r.emptyRetries, llmCalls: r.llmCalls, tokens: r.tokens, summary: r.summary, experiments: r.experiments.map((e) => ({ status: e.status, plan: e.descriptions, hypothesis: e.hypothesis, failed: e.decision?.checks.filter((c) => !c.passed).map((c) => c.name) ?? e.violations })), errors: r.steps.filter((x) => x.kind === 'error').map((x) => (x as { message: string }).message) });
    writeFileSync(`${DIR}/agent-transcripts/${s.id}.json`, JSON.stringify({ model: OPENROUTER_MODEL, provider: PINNED_PROVIDER, calls: rec.log }, null, 2) + '\n');
    log(`${s.id}: ${score.foundOptimal ? 'OPTIMAL' : score.within5 ? 'within 5%' : 'miss'} — agent: ${score.recommendedLabel}; ${r.experiments.length} experiments, ${r.llmCalls} calls, ${r.tokens} tokens, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const endCredits = await llmClient.credits();
  save('agent.json', scores);
  save('agent-runs.json', { model: OPENROUTER_MODEL, provider: PINNED_PROVIDER, tokens: budget.used, reportedCostUsd: llmClient.costUsd, creditsUsedUsd: endCredits.usage - startCredits.usage, creditsRemainingUsd: endCredits.remaining, runs });
  log(`agent: optimal ${scores.filter((x) => x.foundOptimal).length}/${scores.length}, within 5% ${scores.filter((x) => x.within5).length}/${scores.length}; ${budget.used} tokens`);
}

// ---------------------------------------------------------------- false positives
function fresh() {
  const gts = load<GroundTruth[]>('ground-truth.json');
  const rows: Array<{ scenario: string; key: string; label: string; improvementEval: number; improvementFresh: number; ciLowFresh: number; holds: boolean }> = [];
  for (const s of SCENARIOS) {
    const gt = gts.find((g) => g.scenario === s.id)!;
    for (const p of gt.plans.filter((x) => x.status === 'accepted')) {
      const f = freshCheck(s, p.key);
      rows.push({ scenario: s.id, key: p.key, label: p.label, improvementEval: p.improvement!, improvementFresh: f.improvement, ciLowFresh: f.ciLow, holds: f.holds });
    }
    log(`${s.id}: fresh-checked ${gt.plans.filter((x) => x.status === 'accepted').length} accepted plans`);
  }
  save('fresh-check.json', rows);
  log(`false positives: ${rows.filter((r) => !r.holds).length} of ${rows.length} accepted plans`);
}

// ---------------------------------------------------------------- model builder
async function builder() {
  if (!live) throw new Error('The builder phase calls the LLM; pass --live');
  const key = await loadEnvKey('OPENROUTER_API_KEY');
  if (!key) throw new Error('OPENROUTER_API_KEY not found');
  const llmClient = new OpenRouterLlm({ apiKey: key, reasoningEffort: 'low' });
  const before = await llmClient.credits();
  const scores: BuilderScore[] = [];
  const raw: unknown[] = [];
  const cases = process.argv.includes('--heldout') ? [...BUILDER_CASES, ...BUILDER_HELDOUT] : BUILDER_CASES;
  for (const c of cases) {
    const rec = new RecordingLlm(llmClient);
    const r = await buildModelFromDescription(c.description, rec);
    const draft: CafeDraft | null = r.ok ? r.model.draft : null;
    const sc = scoreBuilder(c.id, c.expected, draft);
    scores.push(sc);
    raw.push({ id: c.id, ok: r.ok, draft, llmCalls: r.llmCalls });
    log(`${c.id}: ${sc.correct}/${sc.fields} fields correct, ${sc.invented.length} invented`);
  }
  const after = await llmClient.credits();
  save('builder.json', { scores, raw, reportedCostUsd: llmClient.costUsd, creditsUsedUsd: after.usage - before.usage });
}

if (phase === 'truth' || phase === 'all') truth();
if (phase === 'greedy' || phase === 'all') greedy();
if (phase === 'fresh' || phase === 'all') fresh();
if (phase === 'agent' || (phase === 'all' && live)) await agent();
if (phase === 'builder' || (phase === 'all' && live)) await builder();
if (!existsSync(`${DIR}/ground-truth.json`)) log('no ground truth yet');
