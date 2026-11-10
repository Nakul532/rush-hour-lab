import type { Rng } from './rng';

/**
 * A task-time distribution, in minutes.
 * - lognormal: right-skewed (most tasks quick, a few slow). `median` is the
 *   typical time; `sigma` is the spread on the log scale (0.5 ≈ moderate).
 * - exponential: used for textbook queueing checks (M/M/1).
 * - fixed: always the same time.
 */
export type Dist =
  | { kind: 'fixed'; value: number }
  | { kind: 'exponential'; mean: number }
  | { kind: 'lognormal'; median: number; sigma: number };

export function standardNormal(rng: Rng): number {
  // Box–Muller. 1 - u keeps the log argument in (0, 1].
  const u1 = 1 - rng.next();
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function sample(d: Dist, rng: Rng): number {
  switch (d.kind) {
    case 'fixed':
      return d.value;
    case 'exponential':
      return -d.mean * Math.log(1 - rng.next());
    case 'lognormal':
      return d.median * Math.exp(d.sigma * standardNormal(rng));
  }
}

export function distMean(d: Dist): number {
  switch (d.kind) {
    case 'fixed':
      return d.value;
    case 'exponential':
      return d.mean;
    case 'lognormal':
      return d.median * Math.exp((d.sigma * d.sigma) / 2);
  }
}

export function lognormal(median: number, sigma: number): Dist {
  return { kind: 'lognormal', median, sigma };
}

/** Build a lognormal from a mean and coefficient of variation (sd / mean). */
export function lognormalFromMeanCv(mean: number, cv: number): Dist {
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  return { kind: 'lognormal', median: mean / Math.exp((sigma * sigma) / 2), sigma };
}

/** Return a copy of the distribution with every time multiplied by `factor`. */
export function scaleDist(d: Dist, factor: number): Dist {
  switch (d.kind) {
    case 'fixed':
      return { kind: 'fixed', value: d.value * factor };
    case 'exponential':
      return { kind: 'exponential', mean: d.mean * factor };
    case 'lognormal':
      return { kind: 'lognormal', median: d.median * factor, sigma: d.sigma };
  }
}
