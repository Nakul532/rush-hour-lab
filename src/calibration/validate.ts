// How much to trust the calibration: bootstrap ranges for the observed
// medians, and a leave-one-out check on the 18 orders.

import { Rng } from '../sim/rng';
import { median, quantile } from '../sim/stats';
import type { OrderType } from '../sim/types';
import { OBSERVED_TYPES, type ObservedOrder, type ObservedType } from '../data/observed';
import { bestFit, targetsFrom, type GridPoint } from './fit';

/**
 * 95% bootstrap interval for the observed median of each order type:
 * resample the orders of that type with replacement many times.
 */
export function bootstrapMedians(orders: readonly ObservedOrder[], resamples = 10_000, seed = 18) {
  const rng = new Rng(seed);
  const out = {} as Record<ObservedType, { n: number; median: number; low: number; high: number }>;
  for (const t of OBSERVED_TYPES) {
    const w = orders.filter((o) => o.type === t).map((o) => o.waitMin);
    const meds: number[] = [];
    for (let b = 0; b < resamples; b++) {
      const s = w.map(() => w[Math.floor(rng.next() * w.length)]);
      meds.push(median(s));
    }
    out[t] = { n: w.length, median: median(w), low: quantile(meds, 0.025), high: quantile(meds, 0.975) };
  }
  return out;
}

export interface LooRow {
  id: number;
  type: ObservedType;
  observed: number;
  /** Model refitted on the other 17 orders. */
  predictedMedian: number;
  /** 90% prediction range for one order of this type (5th–95th percentile of simulated waits). */
  low: number;
  high: number;
  inside: boolean;
  /** Baseline: median of the other orders of the same type, with no model. */
  naiveMedian: number;
  fit: GridPoint['params'];
}

/**
 * Leave-one-out: for each order, relearn everything taken from the data
 * (the order mix, including any grab-and-go share, and the fitted task
 * times) from the other 17, then ask whether the held-out wait falls in the
 * refitted model's 90% range. `gridFor(mix)` returns the simulated grid for
 * a given mix; the caller caches it, since folds share only a few distinct mixes.
 * The arrival rate is still taken from all 18 orders.
 */
export function leaveOneOut(
  orders: readonly ObservedOrder[],
  mixFor: (orders: readonly ObservedOrder[]) => Partial<Record<OrderType, number>>,
  gridFor: (mix: Partial<Record<OrderType, number>>) => GridPoint[],
): LooRow[] {
  return orders.map((held) => {
    const rest = orders.filter((o) => o.id !== held.id);
    const { point } = bestFit(gridFor(mixFor(rest)), targetsFrom(rest));
    const q = point.sim[held.type];
    return {
      id: held.id,
      type: held.type,
      observed: held.waitMin,
      predictedMedian: q.median,
      low: q.p05,
      high: q.p95,
      inside: held.waitMin >= q.p05 && held.waitMin <= q.p95,
      naiveMedian: median(rest.filter((o) => o.type === held.type).map((o) => o.waitMin)),
      fit: point.params,
    };
  });
}
