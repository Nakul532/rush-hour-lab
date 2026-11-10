// Calibration check from the brief: the observed-café preset must land close
// to the observed medians. "Close" here means:
//   - drink only (n = 9): within 1.5 min of the observed 4 min, and
//   - every order type: inside the 95% bootstrap range of its observed median.
// Drink + food is known to come out short (see calibration/REPORT.md); this
// test documents that rather than hiding it.
import { describe, expect, it } from 'vitest';
import { OBSERVED_ORDERS, OBSERVED_TYPES } from '../src/data/observed';
import { replicateObserved, targetsFrom } from '../src/calibration/fit';
import { littleLawArrivalRate } from '../src/calibration/observedCafe';
import { bootstrapMedians } from '../src/calibration/validate';
import { observedCafePreset } from '../src/presets/observedCafe';
import { buildConfig } from '../src/sim/cafe';
import { median } from '../src/sim/stats';

describe('observed data (guards against typos in DATA.md transcription)', () => {
  it('has the summary medians stated in DATA.md', () => {
    const t = targetsFrom(OBSERVED_ORDERS);
    expect(OBSERVED_ORDERS).toHaveLength(18);
    expect(median(OBSERVED_ORDERS.map((o) => o.waitMin))).toBe(7.5);
    expect(t.byType.drink.median).toBe(4);
    expect(t.byType.drinkFood.median).toBe(17);
    expect(t.byType.drinkFood.n).toBe(5);
  });

  it("Little's-law arrival rate is 3 / 8.33 ≈ 0.36 per minute", () => {
    expect(littleLawArrivalRate(OBSERVED_ORDERS)).toBeCloseTo(0.36, 6);
  });
});

describe('observed-café preset calibration', () => {
  // Grouped by how orders were logged (grab-and-go items count as drinks).
  const summary = replicateObserved(buildConfig(observedCafePreset()), 300, 20261109);
  const observed = targetsFrom(OBSERVED_ORDERS);
  const boot = bootstrapMedians(OBSERVED_ORDERS);

  it('drink-only median is within 1.5 min of the observed 4 min', () => {
    expect(Math.abs(summary.drink.median.mean - observed.byType.drink.median)).toBeLessThan(1.5);
  });

  for (const t of OBSERVED_TYPES) {
    it(`${t} median is inside the observed 95% bootstrap range`, () => {
      const m = summary[t].median.mean;
      expect(m).toBeGreaterThanOrEqual(boot[t].low);
      expect(m).toBeLessThanOrEqual(boot[t].high);
    });
  }

  it('documents the known gap: drink + food comes out shorter than observed', () => {
    expect(summary.drinkFood.median.mean).toBeLessThan(observed.byType.drinkFood.median);
  });
});
