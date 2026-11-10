import { describe, expect, it } from 'vitest';
import { meanCI, median, quantile, tCrit975 } from '../src/sim/stats';

describe('stats helpers', () => {
  it('quantiles interpolate between ordered values', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([1, 1, 2, 3, 4, 5, 8, 9, 16], 0.9)).toBeCloseTo(10.4, 10);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('t critical values match tables', () => {
    expect(tCrit975(4)).toBeCloseTo(2.776, 3);
    expect(tCrit975(60)).toBeCloseTo(2.0003, 3);
    expect(tCrit975(1000)).toBeCloseTo(1.9623, 3);
  });

  it('95% CI of 1..5 is 3 ± 1.963', () => {
    const ci = meanCI([1, 2, 3, 4, 5]);
    expect(ci.mean).toBe(3);
    expect(ci.high - ci.mean).toBeCloseTo(1.963, 3);
  });

  it('CI skips replications with no value (e.g. no food orders that run)', () => {
    expect(meanCI([1, NaN, 3]).n).toBe(2);
  });
});
