// Stage 3 scoring. LOCKED with the scenarios, before any agent run.
//
// Definitions:
// - Plan evaluation: the acceptance rule (src/agent/evaluate.ts decide())
//   on a plan vs today, at EVAL_SIM (same seed and replications for every
//   plan and every searcher, so numbers are identical for the same plan).
// - Optimal plan: the accepted plan with the largest overall p90
//   improvement; ties → lower cost → fewer changes. If no plan is accepted,
//   the optimal answer is "recommend nothing".
// - Found optimal: the searcher's recommendation is the optimal plan (or
//   both are "nothing").
// - Within 5%: the recommendation's p90 wait ≤ optimal p90 × 1.05 (or both
//   "nothing"). Recommending nothing when a plan exists counts as a miss.
// - Simulations: calls to simulate() (each = one batch of EVAL_SIM.reps
//   replications), counted by code.
// - False positive: a plan the rule accepted at EVAL_SIM that, re-run with a
//   fresh seed and FRESH_SIM.reps replications, no longer shows ≥10%
//   improvement with a paired 95% CI excluding zero.
// - Model builder: per stated field, correct if equal (whole numbers),
//   within 5% (other numbers), or equal (text). Fields the model filled in
//   that the description did not state count as invented.

import type { AnalysisResult, ExperimentRecord } from '../src/agent/agent';
import { runExperiment } from '../src/agent/agent';
import { ChangeError } from '../src/agent/changes';
import { compare, type SimSettings } from '../src/agent/evaluate';
import { applyChanges } from '../src/agent/changes';
import { DEFAULT_COSTS } from '../src/agent/plan';
import { choiceChanges, choiceKey, describeChoice, enumerateChoices, matchPlan, type Choice } from '../src/agent/space';
import type { CafeDraft } from '../src/agent/modelBuilder';
import type { Scenario } from './scenarios';

export const EVAL_SIM: SimSettings = { reps: 200, seed: 31337 };
export const FRESH_SIM: SimSettings = { reps: 1000, seed: 271828 };
export const WITHIN = 0.05;

export interface PlanRow {
  key: string;
  label: string;
  changes: number;
  status: 'accepted' | 'rejected' | 'blocked' | 'invalid';
  improvement: number | null;
  candidateP90: number | null;
  costUsd: number | null;
  failed: string[];
}

export interface GroundTruth {
  scenario: string;
  plans: PlanRow[];
  baseP90: number;
  optimal: PlanRow | null;
  /** Simulations brute force used. */
  simulations: number;
}

export function rowFromExperiment(key: string, label: string, e: ExperimentRecord): PlanRow {
  return {
    key, label, changes: e.changes.length, status: e.status,
    improvement: e.evidence?.nominal.improvement ?? null,
    candidateP90: e.evidence?.nominal.candidateP90 ?? null,
    costUsd: e.costUsd,
    failed: e.status === 'blocked' ? e.violations : (e.decision?.checks.filter((c) => !c.passed).map((c) => c.name) ?? []),
  };
}

export function pickOptimal(plans: PlanRow[]): PlanRow | null {
  const ok = plans.filter((p) => p.status === 'accepted');
  ok.sort((a, b) => b.improvement! - a.improvement! || a.costUsd! - b.costUsd! || a.changes - b.changes);
  return ok[0] ?? null;
}

/** Evaluate one plan of the space (used by brute force and the greedy baseline). */
export function evaluateChoice(s: Scenario, choice: Choice): PlanRow {
  const key = choiceKey(choice);
  const label = describeChoice(s.space, choice);
  const changes = choiceChanges(s.space, choice);
  if (changes.length === 0) return { key, label, changes: 0, status: 'rejected', improvement: 0, candidateP90: null, costUsd: 0, failed: ['No change'] };
  try {
    applyChanges(s.spec, changes); // throws ChangeError for impossible plans
    const e = runExperiment(0, s.spec, '', changes, s.constraints, DEFAULT_COSTS, EVAL_SIM);
    return rowFromExperiment(key, label, e);
  } catch (err) {
    if (err instanceof ChangeError) return { key, label, changes: changes.length, status: 'invalid', improvement: null, candidateP90: null, costUsd: null, failed: [err.message] };
    throw err;
  }
}

export function allChoices(s: Scenario): Choice[] {
  return [...enumerateChoices(s.space)];
}

export interface SearcherScore {
  searcher: string;
  scenario: string;
  recommendedKey: string | null;
  recommendedLabel: string;
  recommendedP90: number | null;
  optimalKey: string | null;
  foundOptimal: boolean;
  within5: boolean;
  simulations: number;
  experiments: number;
  /** Plans tested that the rule accepted. */
  acceptedTested: number;
  notes: string[];
}

export function scoreRecommendation(searcher: string, gt: GroundTruth, recommendedKey: string | null, simulations: number, experiments: number, acceptedTested: number, notes: string[] = []): SearcherScore {
  const rec = recommendedKey === null ? null : gt.plans.find((p) => p.key === recommendedKey) ?? null;
  const opt = gt.optimal;
  const foundOptimal = opt === null ? rec === null : rec?.key === opt.key;
  const within5 = opt === null ? rec === null : rec !== null && rec.candidateP90! <= opt.candidateP90! * (1 + WITHIN);
  return {
    searcher, scenario: gt.scenario, recommendedKey, recommendedLabel: rec?.label ?? 'Nothing', recommendedP90: rec?.candidateP90 ?? null,
    optimalKey: opt?.key ?? null, foundOptimal, within5, simulations, experiments, acceptedTested, notes,
  };
}

/** Map the LLM agent's recommendation back into the space. */
export function agentRecommendationKey(s: Scenario, r: AnalysisResult): string | null {
  if (!r.recommended) return null;
  return choiceKey(matchPlan(s.space, r.recommended.changes, s.spec));
}

/** Re-check an accepted plan with a fresh seed and more replications. */
export function freshCheck(s: Scenario, key: string): { improvement: number; ciLow: number; holds: boolean } {
  const choice = key.split(',').map(Number);
  const c = compare(s.spec, applyChanges(s.spec, choiceChanges(s.space, choice)), FRESH_SIM);
  return { improvement: c.improvement, ciLow: c.diff.low, holds: c.improvement >= 0.1 && c.diff.low > 0 };
}

// ---- model builder ----

function flatten(d: CafeDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (o: unknown, prefix: string) => {
    if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, prefix ? `${prefix}.${k}` : k);
    else if (o !== undefined && o !== null) out[prefix] = o;
  };
  walk(d, '');
  delete out.name;
  return out;
}

export interface BuilderScore {
  id: string;
  fields: number;
  correct: number;
  wrong: Array<{ field: string; expected: unknown; got: unknown }>;
  invented: string[];
}

export function scoreBuilder(id: string, expected: CafeDraft, got: CafeDraft | null): BuilderScore {
  const exp = flatten(expected);
  const out = got ? flatten(got) : {};
  const wrong: BuilderScore['wrong'] = [];
  let correct = 0;
  for (const [field, e] of Object.entries(exp)) {
    const g = out[field];
    const ok =
      typeof e === 'number'
        ? typeof g === 'number' && (Number.isInteger(e) ? g === e : Math.abs(g - e) <= Math.abs(e) * 0.05)
        : typeof e === 'string' && typeof g === 'string'
          ? g.trim().toLowerCase().replace(/^(\d):/, '0$1:') === e.toLowerCase()
          : g === e;
    if (ok) correct++;
    else wrong.push({ field, expected: e, got: g });
  }
  const invented = Object.keys(out).filter((f) => !(f in exp));
  return { id, fields: Object.keys(exp).length, correct, wrong, invented };
}
