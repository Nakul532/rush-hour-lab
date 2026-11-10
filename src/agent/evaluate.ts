// The agent's measuring tools: run a café, find its bottleneck, compare two
// cafés on the same simulated customers, re-check with task times ±30%, and
// the deterministic acceptance rule. No LLM is involved in any of this.

import { buildConfig, type CafeSpec } from '../sim/cafe';
import { scaleDist } from '../sim/distributions';
import { runReplications } from '../sim/replicate';
import { meanCI, type Interval } from '../sim/stats';
import { ORDER_TYPES, type OrderType, type RunResult } from '../sim/types';

export interface SimSettings {
  reps: number;
  seed: number;
}
export const DEFAULT_SIM: SimSettings = { reps: 300, seed: 20261109 };

export interface ResultSummary {
  provenance: 'SIMULATED';
  reps: number;
  overall: { median: Interval; p90: Interval };
  byType: Partial<Record<OrderType, { median: Interval; p90: Interval; orders: number }>>;
  ordersServed: Interval;
  stations: Record<string, { utilization: number | null; maxQueue: number }>;
}

function summarizeRuns(runs: RunResult[]): ResultSummary {
  const byType: ResultSummary['byType'] = {};
  for (const t of ORDER_TYPES) {
    const orders = runs.reduce((acc, r) => acc + r.wait[t].n, 0) / runs.length;
    if (orders === 0) continue;
    byType[t] = { median: meanCI(runs.map((r) => r.wait[t].median)), p90: meanCI(runs.map((r) => r.wait[t].p90)), orders };
  }
  const stations: ResultSummary['stations'] = {};
  for (const id of Object.keys(runs[0].stations)) {
    const u = runs.map((r) => r.stations[id].utilization);
    stations[id] = {
      utilization: u[0] === null ? null : u.reduce((acc: number, x) => acc + (x ?? 0), 0) / runs.length,
      maxQueue: runs.reduce((a, r) => a + r.stations[id].maxQueue, 0) / runs.length,
    };
  }
  return {
    provenance: 'SIMULATED',
    reps: runs.length,
    overall: { median: meanCI(runs.map((r) => r.wait.all.median)), p90: meanCI(runs.map((r) => r.wait.all.p90)) },
    byType,
    ordersServed: meanCI(runs.map((r) => r.served)),
    stations,
  };
}

/** Counts simulate() calls (each = one batch of replications). Used by the evaluation. */
export const simulationCounter = { count: 0 };

export function simulate(spec: CafeSpec, sim: SimSettings = DEFAULT_SIM): { summary: ResultSummary; runs: RunResult[] } {
  simulationCounter.count++;
  const runs = runReplications(buildConfig(spec), sim.reps, sim.seed);
  return { summary: summarizeRuns(runs), runs };
}

export interface Bottleneck {
  station: string;
  utilization: number;
  maxQueue: number;
  /** Every station with staff, busiest first. */
  ranking: Array<{ station: string; utilization: number; maxQueue: number }>;
}

/** The busiest staffed station. Ties go to the longer queue. */
export function findBottleneck(summary: ResultSummary): Bottleneck {
  const ranking = Object.entries(summary.stations)
    .filter(([, s]) => s.utilization !== null)
    .map(([station, s]) => ({ station, utilization: s.utilization as number, maxQueue: s.maxQueue }))
    .sort((a, b) => b.utilization - a.utilization || b.maxQueue - a.maxQueue);
  return { ...ranking[0], ranking };
}

export interface Comparison {
  /** Overall 90th-percentile wait, mean across replications. */
  baseP90: number;
  candidateP90: number;
  /** base − candidate, paired by replication (same customers). Positive = candidate is better. */
  diff: Interval;
  /** diff / base p90. 0.12 = 12% shorter bad-case wait. */
  improvement: number;
  /** Orders never served per rush (mean). Anything above 0 means the plan is broken. */
  candidateUnserved: number;
  byType: Partial<Record<OrderType, { baseP90: number; candidateP90: number; change: number }>>;
}

function pairedCompare(base: RunResult[], cand: RunResult[]): Comparison {
  const diffs = base.map((b, i) => b.wait.all.p90 - cand[i].wait.all.p90);
  const baseP90 = meanCI(base.map((r) => r.wait.all.p90)).mean;
  const candidateP90 = meanCI(cand.map((r) => r.wait.all.p90)).mean;
  const diff = meanCI(diffs);
  const byType: Comparison['byType'] = {};
  for (const t of ORDER_TYPES) {
    // Only replications where both cafés had orders of this type.
    const pairs = base.map((b, i) => [b.wait[t].p90, cand[i].wait[t].p90]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (pairs.length === 0) continue;
    const b = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
    const c = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
    byType[t] = { baseP90: b, candidateP90: c, change: b > 0 ? (c - b) / b : 0 };
  }
  const candidateUnserved = cand.reduce((a, r) => a + r.unserved, 0) / cand.length;
  return { baseP90, candidateP90, diff, improvement: baseP90 > 0 ? diff.mean / baseP90 : 0, candidateUnserved, byType };
}

/** Compare two cafés on identical simulated customers (common random numbers). */
export function compare(base: CafeSpec, candidate: CafeSpec, sim: SimSettings = DEFAULT_SIM): Comparison {
  return pairedCompare(simulate(base, sim).runs, simulate(candidate, sim).runs);
}

/** Multiply every task time (and batch cook time) by `factor`. */
export function scaleTaskTimes(spec: CafeSpec, factor: number): CafeSpec {
  const s = structuredClone(spec);
  s.times = {
    order: scaleDist(s.times.order, factor),
    drink: scaleDist(s.times.drink, factor),
    food: scaleDist(s.times.food, factor),
    handoff: scaleDist(s.times.handoff, factor),
    ...(s.times.grab ? { grab: scaleDist(s.times.grab, factor) } : {}),
  };
  if (s.foodBatching) s.foodBatching = { ...s.foodBatching, cookMin: s.foodBatching.cookMin * factor };
  return s;
}

export const SENSITIVITY = 0.3;

export interface Evidence {
  nominal: Comparison;
  /** Task times 30% shorter. */
  faster: Comparison;
  /** Task times 30% longer. */
  slower: Comparison;
}

export function sensitivity(base: CafeSpec, candidate: CafeSpec, sim: SimSettings = DEFAULT_SIM): Evidence {
  return {
    nominal: compare(base, candidate, sim),
    faster: compare(scaleTaskTimes(base, 1 - SENSITIVITY), scaleTaskTimes(candidate, 1 - SENSITIVITY), sim),
    slower: compare(scaleTaskTimes(base, 1 + SENSITIVITY), scaleTaskTimes(candidate, 1 + SENSITIVITY), sim),
  };
}

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface Decision {
  accepted: boolean;
  checks: Check[];
}

export const MIN_IMPROVEMENT = 0.1;
export const MAX_TYPE_WORSENING = 0.1;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const min = (x: number) => `${x.toFixed(1)} min`;

/**
 * The acceptance rule. A change is recommended only if all five checks pass:
 *  1. overall p90 wait improves by at least 10%;
 *  2. the paired 95% CI of that improvement excludes zero;
 *  3. it still improves with task times 30% shorter;
 *  4. it still improves with task times 30% longer;
 *  5. no single order type's p90 gets more than 10% worse;
 *  6. every order is served (also with task times ±30%).
 */
export function decide(e: Evidence): Decision {
  const n = e.nominal;
  const worse = Object.entries(n.byType).filter(([, v]) => v!.change > MAX_TYPE_WORSENING);
  const checks: Check[] = [
    {
      name: 'Bad-case wait improves by at least 10%',
      passed: n.improvement >= MIN_IMPROVEMENT,
      detail: `Overall p90 ${min(n.baseP90)} → ${min(n.candidateP90)} (${pct(Math.abs(n.improvement))} ${n.improvement >= 0 ? 'shorter' : 'longer'})`,
    },
    {
      name: 'Improvement is clear of simulation noise',
      passed: n.diff.low > 0,
      detail: `Paired 95% CI of the improvement: ${min(n.diff.low)} to ${min(n.diff.high)}`,
    },
    {
      name: 'Still helps if tasks are 30% faster',
      passed: e.faster.diff.mean > 0,
      detail: `p90 ${min(e.faster.baseP90)} → ${min(e.faster.candidateP90)}`,
    },
    {
      name: 'Still helps if tasks are 30% slower',
      passed: e.slower.diff.mean > 0,
      detail: `p90 ${min(e.slower.baseP90)} → ${min(e.slower.candidateP90)}`,
    },
    {
      name: 'No order type gets more than 10% worse',
      passed: worse.length === 0,
      detail:
        worse.length === 0
          ? 'Every order type stays within 10% of its current p90 or improves'
          : worse.map(([t, v]) => `${t} p90 ${min(v!.baseP90)} → ${min(v!.candidateP90)} (${pct(v!.change)} worse)`).join('; '),
    },
    {
      name: 'Every order gets served',
      passed: n.candidateUnserved === 0 && e.faster.candidateUnserved === 0 && e.slower.candidateUnserved === 0,
      detail:
        n.candidateUnserved + e.faster.candidateUnserved + e.slower.candidateUnserved === 0
          ? 'No order is left waiting at the end'
          : `About ${Math.round(n.candidateUnserved)} orders per rush are never served`,
    },
  ];
  return { accepted: checks.every((c) => c.passed), checks };
}
