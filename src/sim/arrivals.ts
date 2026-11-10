import type { Rng } from './rng';
import type { ArrivalCurve } from './types';

export function windowMinutes(curve: ArrivalCurve): number {
  return curve.bucketMinutes * curve.ratePerMin.length;
}

/**
 * Customer arrival times for a non-homogeneous Poisson process whose rate is
 * constant within each bucket (e.g. each 15 minutes). Because the exponential
 * gap is memoryless, restarting the gap at each bucket boundary is exact.
 */
export function generateArrivals(curve: ArrivalCurve, rng: Rng): number[] {
  const times: number[] = [];
  curve.ratePerMin.forEach((rate, b) => {
    if (!(rate > 0)) return;
    const start = b * curve.bucketMinutes;
    const end = start + curve.bucketMinutes;
    let t = start;
    for (;;) {
      t += -Math.log(1 - rng.next()) / rate;
      if (t >= end) break;
      times.push(t);
    }
  });
  return times;
}

/** A curve with one constant rate for `minutes` minutes. */
export function constantCurve(ratePerMin: number, minutes: number, bucketMinutes = 15): ArrivalCurve {
  const buckets = Math.max(1, Math.round(minutes / bucketMinutes));
  return { bucketMinutes: minutes / buckets, ratePerMin: new Array(buckets).fill(ratePerMin) };
}

export function scaleCurve(curve: ArrivalCurve, factor: number): ArrivalCurve {
  return { bucketMinutes: curve.bucketMinutes, ratePerMin: curve.ratePerMin.map((r) => r * factor) };
}
