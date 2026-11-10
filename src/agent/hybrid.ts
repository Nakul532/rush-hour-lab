// Hybrid recommender (Stage 4 design, from the Stage 3 results).
//
// 1. Code builds a change space for the café (≤ ~300 plans when possible).
// 2. Code searches it: brute force when the space is small enough for the
//    time budget, greedy otherwise.
// 3. If an LLM is available, the agent also proposes and tests plans in the
//    same space (it is best placed to find combinations greedy can miss, but
//    in our evaluation it never beat brute force).
// 4. The best plan that passes the acceptance rule is re-checked on a fresh
//    seed with more replications. If it no longer passes, the next best is
//    checked. Only a verified plan is recommended.
// 5. Every result says which method found it.

import { windowMinutes } from '../sim/arrivals';
import type { CafeSpec } from '../sim/cafe';
import { toWindows } from '../sim/cafe';
import { runAnalysis, runExperiment, type AgentStep, type ExperimentRecord } from './agent';
import { applyChanges, type Change, type StationName } from './changes';
import { decide, sensitivity, simulate, type SimSettings } from './evaluate';
import type { LlmClient } from './llm';
import { DEFAULT_COSTS, type Constraints, type CostTable } from './plan';
import { choiceChanges, choiceKey, describeChoice, enumerateChoices, matchPlan, spaceSize, type ChangeSpace, type Choice, type Lever } from './space';

export type Method = 'Brute force' | 'Greedy search' | 'LLM agent';

export interface TestedPlan {
  key: string;
  label: string;
  record: ExperimentRecord;
  /** Every method that tested this plan. */
  foundBy: Method[];
}

export interface Verification {
  passed: boolean;
  baseP90: number;
  candidateP90: number;
  improvement: number;
  ciLow: number;
  reps: number;
}

export interface HybridResult {
  space: ChangeSpace;
  searchMethod: 'Brute force' | 'Greedy search';
  plans: TestedPlan[];
  recommended: (TestedPlan & { verification: Verification }) | null;
  /** Plans that passed the search but not the fresh re-check. */
  failedVerification: Array<TestedPlan & { verification: Verification }>;
  agent: { ran: boolean; steps: AgentStep[]; stopReason?: string; llmCalls: number; summary: string | null; error?: string };
  simulations: number;
}

export interface HybridOptions {
  constraints?: Constraints;
  costs?: CostTable;
  /** Replications per plan during search. */
  searchSim?: SimSettings;
  /** Replications for the final re-check (different seed). */
  verifySim?: SimSettings;
  /** Search budget in simulated customer-replications (~1.4M/s in Node); above it, greedy is used. */
  bruteForceBudget?: number;
  llm?: LlmClient;
  onProgress?: (p: { phase: string; done: number; total: number }) => void;
}

const S = (station: StationName, delta = 1, fromMin?: number, toMin?: number): Change => ({
  kind: 'staff', station, delta, ...(fromMin !== undefined ? { fromMin } : {}), ...(toMin !== undefined ? { toMin } : {}),
});

function staffNow(spec: CafeSpec, k: keyof CafeSpec['staff']): number {
  const s = spec.staff[k];
  return s === undefined ? 0 : toWindows(s)[0].servers;
}

/** The busiest 30 minutes of the rush (by arrival rate), rounded to 15-minute buckets. */
export function peakWindow(spec: CafeSpec): { fromMin: number; toMin: number } {
  const { bucketMinutes, ratePerMin } = spec.arrivals;
  const rush = windowMinutes(spec.arrivals);
  const span = Math.max(1, Math.round(30 / bucketMinutes));
  let best = 0;
  let bestSum = -1;
  for (let i = 0; i + span <= ratePerMin.length; i++) {
    const sum = ratePerMin.slice(i, i + span).reduce((a, b) => a + b, 0);
    if (sum > bestSum + 1e-12) {
      bestSum = sum;
      best = i;
    }
  }
  const fromMin = best * bucketMinutes;
  return { fromMin, toMin: Math.min(rush, fromMin + span * bucketMinutes) };
}

/** Options the recommender considers for this café. */
/** Most plans the recommender will consider (brute-force size). */
export const MAX_PLANS = 300;

/** Used for the final re-check and the before/after table, so all shown numbers agree. */
export const VERIFY_SIM = { reps: 1000, seed: 8675309 };

/**
 * Options the recommender considers for this café. Each option group gets a
 * relevance score from how busy the station it relieves is; groups are added
 * most relevant first while the number of plans stays within MAX_PLANS
 * (a group that does not fit whole is tried with its first option only).
 */
export function buildSpace(spec: CafeSpec, constraints: Constraints = {}, utilization: Record<string, number> = {}): ChangeSpace {
  const peak = peakWindow(spec);
  const rates = spec.arrivals.ratePerMin;
  const flat = rates.every((r) => Math.abs(r - rates[0]) < 1e-9);
  const clock = (m: number) => {
    if (!spec.startsAt) return `min ${m}`;
    const [h, mm] = spec.startsAt.split(':').map(Number);
    const t = h * 60 + mm + m;
    return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const peakLabel = `${clock(peak.fromMin)}–${clock(peak.toMin)}`;
  const mixTotal = Object.values(spec.mix).reduce((a, b) => a + (b ?? 0), 0) || 1;
  const share = (k: keyof CafeSpec['mix']) => (spec.mix[k] ?? 0) / mixTotal;
  const usesKitchen = (share('food') + share('drinkFood') > 0) && !spec.foodBatching;
  const stations: StationName[] = ['barista', ...(usesKitchen ? ['kitchen' as const] : []), 'cashier', ...(spec.handoff === 'dedicated' ? ['handoff' as const] : [])];
  const u = (st: string) => utilization[st] ?? 0.5;
  const scored: Array<{ lever: Lever; relevance: number }> = [];
  const add = (lever: Lever, relevance: number) => scored.push({ lever, relevance });

  for (const st of stations) {
    const options = constraints.noNewHires
      ? stations
          .filter((from) => from !== st && staffNow(spec, from) >= 2)
          .map((from) => ({ label: `move one person from ${from} to ${st}`, changes: [S(from, -1), S(st, 1)] }))
      : [
          { label: `+1 ${st}`, changes: [S(st)] },
          // Peak-only staff only makes sense when the rush has a peak.
          ...(flat ? [] : [{ label: `+1 ${st} ${peakLabel}`, changes: [S(st, 1, peak.fromMin, peak.toMin)] }]),
        ];
    if (options.length) add({ id: `staff-${st}`, label: `${st[0].toUpperCase()}${st.slice(1)} staff`, options }, u(st));
  }
  if (share('drinkFood') > 0)
    add({ id: 'prep', label: 'Prep order', options: [{ label: spec.prepMode === 'parallel' ? 'drink first, then food' : 'make drink and food at the same time', changes: [{ kind: 'prepMode', mode: spec.prepMode === 'parallel' ? 'sequential' : 'parallel' }] }] }, Math.max(u('barista'), u('kitchen')) * (spec.prepMode === 'sequential' ? 1 : 0.5));
  if (spec.handoff !== 'dedicated' && !constraints.noNewHires)
    add({ id: 'handoff', label: 'Handoff point', options: [{ label: 'dedicated handoff point (1 person)', changes: [{ kind: 'dedicatedHandoff', staff: 1 }] }] }, u('barista') * 0.9);
  if (share('drink') > 0.1)
    add({ id: 'grab', label: 'Grab-and-go', options: [0.2, 0.4].map((x) => ({ label: `sell ${x * 100}% of drink-only orders ready-made`, changes: [{ kind: 'grabGo', shareOfDrinks: x }] })) }, u('barista') * 0.95);
  if (usesKitchen) {
    const foodPerMin = spec.arrivals.ratePerMin.reduce((a, b) => a + b, 0) / spec.arrivals.ratePerMin.length * (share('food') + share('drinkFood'));
    const batch = Math.max(2, Math.ceil(foodPerMin * 15));
    add({ id: 'batching', label: 'Food batching', options: [{ label: `cook food in batches of ${batch} every 15 min`, changes: [{ kind: 'foodBatching', intervalMin: 15, batchSize: batch }] }] }, u('kitchen') * 0.9);
  }
  if (share('drink') >= 0.4 && spec.drinkOnlyStation !== 'express' && !constraints.noNewHires)
    add({ id: 'express', label: 'Express drinks', options: [{ label: 'express station for drink-only orders (1 person)', changes: [{ kind: 'expressDrinks', staff: 1 }] }] }, u('barista') * 0.8);

  scored.sort((a, b) => b.relevance - a.relevance);
  const levers: Lever[] = [];
  let size = 1;
  for (const { lever } of scored) {
    if (size * (lever.options.length + 1) <= MAX_PLANS) {
      levers.push(lever);
      size *= lever.options.length + 1;
    } else if (size * 2 <= MAX_PLANS) {
      levers.push({ ...lever, options: lever.options.slice(0, 1) });
      size *= 2;
    }
  }
  return levers;
}

function evaluate(spec: CafeSpec, space: ChangeSpace, choice: Choice, constraints: Constraints, costs: CostTable, sim: SimSettings): ExperimentRecord | null {
  const changes = choiceChanges(space, choice);
  if (changes.length === 0) return null;
  // runExperiment applies the shared plan validator; invalid plans come back with status 'invalid'.
  return runExperiment(0, spec, '', changes, constraints, costs, sim);
}

export async function recommend(spec: CafeSpec, opts: HybridOptions = {}): Promise<HybridResult> {
  const constraints = opts.constraints ?? {};
  const costs = opts.costs ?? DEFAULT_COSTS;
  const searchSim = opts.searchSim ?? { reps: 150, seed: 20261109 };
  const verifySim = opts.verifySim ?? VERIFY_SIM;
  const progress = opts.onProgress ?? (() => {});
  // Today's utilization (ranks the options) and size (estimates search cost).
  const t0 = simulate(spec, { reps: 20, seed: 1 });
  const utilization: Record<string, number> = {};
  for (const [id, st] of Object.entries(t0.summary.stations)) if (st.utilization !== null) utilization[id] = st.utilization;
  const space = buildSpace(spec, constraints, utilization);
  const size = spaceSize(space);

  const customersPerRep = t0.runs.reduce((a, r) => a + r.arrivals, 0) / t0.runs.length;
  const bruteCost = size * 6 * searchSim.reps * customersPerRep;
  const searchMethod: HybridResult['searchMethod'] = bruteCost <= (opts.bruteForceBudget ?? 25_000_000) ? 'Brute force' : 'Greedy search';

  const tested = new Map<string, TestedPlan>();
  let simulations = 0;
  const record = (choice: Choice, method: Method): TestedPlan | null => {
    const key = choiceKey(choice);
    const existing = tested.get(key);
    if (existing) {
      if (!existing.foundBy.includes(method)) existing.foundBy.push(method);
      return existing;
    }
    const r = evaluate(spec, space, choice, constraints, costs, searchSim);
    if (!r) return null;
    if (r.status === 'accepted' || r.status === 'rejected') simulations += 6;
    const plan: TestedPlan = { key, label: describeChoice(space, choice), record: r, foundBy: [method] };
    tested.set(key, plan);
    return plan;
  };

  // ---- 1. Code search ----
  if (searchMethod === 'Brute force') {
    const all = [...enumerateChoices(space)];
    all.forEach((c, i) => {
      record(c, 'Brute force');
      if (i % 10 === 0) progress({ phase: 'Testing every combination', done: i, total: all.length });
    });
  } else {
    let current: Choice = space.map(() => -1);
    let bestImp = 0;
    for (let round = 0; round < space.length; round++) {
      let roundBest: { c: Choice; imp: number } | null = null;
      space.forEach((lever, i) => {
        if (current[i] >= 0) return;
        lever.options.forEach((_, j) => {
          const c = [...current];
          c[i] = j;
          const p = record(c, 'Greedy search');
          const imp = p?.record.evidence?.nominal.improvement ?? -Infinity;
          if (p?.record.status === 'accepted' && (!roundBest || imp > roundBest.imp)) roundBest = { c, imp };
        });
      });
      progress({ phase: 'Searching step by step', done: round + 1, total: space.length });
      const rb = roundBest as { c: Choice; imp: number } | null;
      if (!rb || rb.imp <= bestImp) break;
      current = rb.c;
      bestImp = rb.imp;
    }
  }

  // ---- 2. LLM agent proposes in the same space (optional) ----
  const agent: HybridResult['agent'] = { ran: false, steps: [], llmCalls: 0, summary: null };
  if (opts.llm) {
    progress({ phase: 'AI analyst running experiments', done: 0, total: 1 });
    try {
      const r = await runAnalysis(spec, opts.llm, { constraints, costs, sim: searchSim, changeSpace: space, maxExperiments: 5, maxLlmCalls: 10 });
      agent.ran = r.llmCalls > 0;
      if (!agent.ran) {
        const firstError = r.steps.find((s): s is Extract<AgentStep, { kind: 'error' }> => s.kind === 'error');
        agent.error = firstError?.message ?? 'The AI analyst could not be reached.';
      }
      agent.steps = r.steps;
      agent.stopReason = r.stopReason;
      agent.llmCalls = r.llmCalls;
      agent.summary = r.summary;
      for (const e of r.experiments) {
        if (e.status === 'blocked' || e.status === 'invalid') continue;
        try {
          record(matchPlan(space, e.changes, spec), 'LLM agent');
        } catch {
          /* outside the space: ignored */
        }
      }
    } catch (err) {
      agent.error = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- 3. Pick the best accepted plan, then verify on a fresh seed ----
  const plans = [...tested.values()];
  const accepted = plans
    .filter((p) => p.record.status === 'accepted')
    .sort((a, b) => b.record.evidence!.nominal.improvement - a.record.evidence!.nominal.improvement || a.record.costUsd - b.record.costUsd || a.record.changes.length - b.record.changes.length);
  const failedVerification: HybridResult['failedVerification'] = [];
  let recommended: HybridResult['recommended'] = null;
  for (const p of accepted.slice(0, 5)) {
    progress({ phase: 'Re-checking the best plan with a fresh simulation', done: failedVerification.length, total: 5 });
    const ev = sensitivity(spec, applyChanges(spec, p.record.changes), verifySim);
    const d = decide(ev);
    const verification = { passed: d.accepted, baseP90: ev.nominal.baseP90, candidateP90: ev.nominal.candidateP90, improvement: ev.nominal.improvement, ciLow: ev.nominal.diff.low, reps: verifySim.reps };
    if (d.accepted) {
      recommended = { ...p, verification };
      break;
    }
    failedVerification.push({ ...p, verification });
  }
  return { space, searchMethod, plans, recommended, failedVerification, agent, simulations };
}
