// Small statistics helpers. Quantiles use linear interpolation between
// order statistics (the common "type 7" definition, same as Excel/NumPy).

export function sortedCopy(xs: ArrayLike<number>): number[] {
  return Array.from(xs).sort((a, b) => a - b);
}

/** Quantile of an already-sorted array. Returns NaN for an empty array. */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

export function quantile(xs: ArrayLike<number>, p: number): number {
  return quantileSorted(sortedCopy(xs), p);
}

export function median(xs: ArrayLike<number>): number {
  return quantile(xs, 0.5);
}

export function mean(xs: ArrayLike<number>): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s / xs.length;
}

export function sampleSd(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - m) ** 2;
  return Math.sqrt(s / (n - 1));
}

/**
 * 97.5th percentile of Student's t with `df` degrees of freedom (for a
 * two-sided 95% interval). Exact table for small df, series expansion above.
 */
export function tCrit975(df: number): number {
  const table = [
    NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
    2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
  ];
  if (df < 1) return NaN;
  if (df <= 30) return table[Math.floor(df)];
  const z = 1.959963984540054;
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
  );
}

export interface Interval {
  mean: number;
  low: number;
  high: number;
  /** Number of replications that produced a value (NaNs are skipped). */
  n: number;
}

/** Mean and 95% confidence interval across replications (t-interval). */
export function meanCI(values: ArrayLike<number>): Interval {
  const xs = Array.from(values).filter((v) => Number.isFinite(v));
  const n = xs.length;
  const m = mean(xs);
  if (n < 2) return { mean: m, low: NaN, high: NaN, n };
  const half = (tCrit975(n - 1) * sampleSd(xs)) / Math.sqrt(n);
  return { mean: m, low: m - half, high: m + half, n };
}
