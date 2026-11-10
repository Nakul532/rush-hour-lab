// Calibration: search a grid of task-time settings and pick the one whose
// simulated waits best match the observed waits.
//
// Score (lower is better), per observed order type t with n_t orders:
//   Σ_t n_t × [ (sim median − observed median)² + (sim p90 − observed p90)² ]
// The median is the typical wait; the 90th percentile is the bad-case wait,
// which is the number the agent will try to improve. Weighting by n_t means
// the 9 drink orders count for more than the 4 food orders.
//
// Simulated orders are compared in the column they would have been logged in:
// grab-and-go items count as "drink", as they did in the observation log.

import { runOnce } from '../sim/engine';
import { replicationSeed } from '../sim/replicate';
import { meanCI, quantileSorted, type Interval } from '../sim/stats';
import type { OrderType, SimConfig } from '../sim/types';
import { OBSERVED_TYPES, type ObservedOrder, type ObservedType } from '../data/observed';
import { observedCafeConfig, observedCategory, type FitParams } from './observedCafe';

export interface TypeQuantiles {
  n: number;
  p05: number;
  median: number;
  p90: number;
  p95: number;
}

export interface GridPoint {
  params: FitParams;
  /** Simulated waits pooled over all replications, by observed order type. */
  sim: Record<ObservedType, TypeQuantiles>;
  /** Busy share of the barista and kitchen (mean over replications). */
  utilization: { barista: number; kitchen: number };
}

export interface Targets {
  byType: Record<ObservedType, { n: number; median: number; p90: number }>;
}

export interface GridSpec {
  drinkMedian: number[];
  foodMedian: number[];
  sigma: number[];
  prepMode: Array<FitParams['prepMode']>;
}

type Mix = Partial<Record<OrderType, number>>;

export function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let x = from; x <= to + 1e-9; x += step) out.push(Math.round(x * 1000) / 1000);
  return out;
}

export function targetsFrom(orders: readonly ObservedOrder[]): Targets {
  const byType = {} as Targets['byType'];
  for (const t of OBSERVED_TYPES) {
    const w = orders.filter((o) => o.type === t).map((o) => o.waitMin).sort((a, b) => a - b);
    byType[t] = { n: w.length, median: quantileSorted(w, 0.5), p90: quantileSorted(w, 0.9) };
  }
  return { byType };
}

/** Simulate one setting: `reps` replications, waits pooled per observed order type. */
export function simulatePoint(params: FitParams, ratePerMin: number, mix: Mix, reps: number, seed: number): GridPoint {
  const config = observedCafeConfig(params, ratePerMin, mix);
  const pooled: Record<ObservedType, number[]> = { drink: [], food: [], drinkFood: [] };
  let barista = 0;
  let kitchen = 0;
  for (let i = 0; i < reps; i++) {
    // Same seeds for every grid point: each setting sees the same customers.
    const r = runOnce(config, replicationSeed(seed, i), { keepCustomers: true });
    for (const c of r.customers!) if (c.arrival >= (config.measureFromMin ?? 0)) pooled[observedCategory(c.type)].push(c.wait);
    barista += r.stations.barista.utilization ?? 0;
    kitchen += r.stations.kitchen.utilization ?? 0;
  }
  const sim = {} as Record<ObservedType, TypeQuantiles>;
  for (const t of OBSERVED_TYPES) {
    const s = pooled[t].sort((a, b) => a - b);
    sim[t] = {
      n: s.length,
      p05: quantileSorted(s, 0.05),
      median: quantileSorted(s, 0.5),
      p90: quantileSorted(s, 0.9),
      p95: quantileSorted(s, 0.95),
    };
  }
  return { params, sim, utilization: { barista: barista / reps, kitchen: kitchen / reps } };
}

export function simulateGrid(grid: GridSpec, ratePerMin: number, mix: Mix, reps: number, seed: number): GridPoint[] {
  const points: GridPoint[] = [];
  for (const prepMode of grid.prepMode)
    for (const sigma of grid.sigma)
      for (const drinkMedian of grid.drinkMedian)
        for (const foodMedian of grid.foodMedian)
          points.push(simulatePoint({ drinkMedian, foodMedian, sigma, prepMode }, ratePerMin, mix, reps, seed));
  return points;
}

export function score(point: GridPoint, targets: Targets): number {
  let s = 0;
  for (const t of OBSERVED_TYPES) {
    const obs = targets.byType[t];
    if (obs.n === 0) continue;
    const sim = point.sim[t];
    s += obs.n * ((sim.median - obs.median) ** 2 + (sim.p90 - obs.p90) ** 2);
  }
  return s;
}

export function bestFit(points: GridPoint[], targets: Targets): { point: GridPoint; score: number } {
  let best = points[0];
  let bestScore = Infinity;
  for (const p of points) {
    const s = score(p, targets);
    if (s < bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return { point: best, score: bestScore };
}

/** Which fitted values sit on the edge of the grid (a sign the grid is too narrow). */
export function onGridEdge(p: FitParams, grid: GridSpec): string[] {
  const edges: string[] = [];
  const check = (name: keyof GridSpec & keyof FitParams, xs: number[]) => {
    const v = p[name] as number;
    if (v === xs[0] || v === xs[xs.length - 1]) edges.push(name);
  };
  check('drinkMedian', grid.drinkMedian);
  check('foodMedian', grid.foodMedian);
  check('sigma', grid.sigma);
  return edges;
}

/**
 * The engine's standard per-rush summary (median and p90 per replication,
 * mean with 95% CI), grouped by observed order type so it can be compared
 * with the log.
 */
export function replicateObserved(config: SimConfig, reps: number, seed: number): Record<ObservedType, { median: Interval; p90: Interval }> {
  const per: Record<ObservedType, { median: number[]; p90: number[] }> = {
    drink: { median: [], p90: [] }, food: { median: [], p90: [] }, drinkFood: { median: [], p90: [] },
  };
  for (let i = 0; i < reps; i++) {
    const r = runOnce(config, replicationSeed(seed, i), { keepCustomers: true });
    const waits: Record<ObservedType, number[]> = { drink: [], food: [], drinkFood: [] };
    for (const c of r.customers!) if (c.arrival >= (config.measureFromMin ?? 0)) waits[observedCategory(c.type)].push(c.wait);
    for (const t of OBSERVED_TYPES) {
      const s = waits[t].sort((a, b) => a - b);
      per[t].median.push(quantileSorted(s, 0.5));
      per[t].p90.push(quantileSorted(s, 0.9));
    }
  }
  const out = {} as Record<ObservedType, { median: Interval; p90: Interval }>;
  for (const t of OBSERVED_TYPES) out[t] = { median: meanCI(per[t].median), p90: meanCI(per[t].p90) };
  return out;
}
