// Tests 2 and 3 from the brief (Little's law, same seed → same result),
// plus sanity checks on routing, staffing, batching and arrivals.
import { describe, expect, it } from 'vitest';
import { generateArrivals } from '../src/sim/arrivals';
import { buildConfig, type CafeSpec } from '../src/sim/cafe';
import { lognormal, sample, type Dist } from '../src/sim/distributions';
import { ConfigError, runOnce } from '../src/sim/engine';
import { replicate } from '../src/sim/replicate';
import { Rng } from '../src/sim/rng';
import { mean, median } from '../src/sim/stats';

const fixed = (value: number): Dist => ({ kind: 'fixed', value });

/** A busy café with most options switched on: varying arrivals, a staff change mid-rush, batching, dedicated handoff. */
function busyCafe(overrides: Partial<CafeSpec> = {}): CafeSpec {
  return {
    name: 'test café',
    arrivals: { bucketMinutes: 15, ratePerMin: [0.4, 0.9, 1.3, 1.1, 0.7, 0.3, 0.6, 0.2] },
    mix: { drink: 0.5, food: 0.2, drinkFood: 0.3 },
    staff: {
      cashier: 1,
      barista: [{ fromMin: 0, servers: 1 }, { fromMin: 30, servers: 2 }, { fromMin: 90, servers: 1 }],
      kitchen: 1,
      handoff: 1,
    },
    times: { order: lognormal(0.8, 0.4), drink: lognormal(1.6, 0.5), food: lognormal(3, 0.6), handoff: lognormal(0.3, 0.4) },
    prepMode: 'parallel',
    handoff: 'dedicated',
    foodBatching: { intervalMin: 10, batchSize: 6, cookMin: 8 },
    ...overrides,
  };
}

describe("Little's law (L = λW)", () => {
  for (const seed of [1, 2, 3, 42, 999]) {
    it(`holds exactly on a time-varying café run (seed ${seed})`, () => {
      const r = runOnce(buildConfig(busyCafe()), seed);
      expect(r.served).toBeGreaterThan(50);
      // L is tracked from events; λW from per-customer times. They must agree.
      expect(Math.abs(r.little.L - r.little.lambda * r.little.W) / r.little.L).toBeLessThan(1e-9);
    });
  }
});

describe('determinism', () => {
  const config = buildConfig(busyCafe());

  it('same seed gives identical results, customer by customer', () => {
    expect(runOnce(config, 123, { keepCustomers: true })).toEqual(runOnce(config, 123, { keepCustomers: true }));
  });

  it('different seeds give different results', () => {
    expect(runOnce(config, 123, { keepCustomers: true })).not.toEqual(runOnce(config, 124, { keepCustomers: true }));
  });

  it('replications with the same base seed give identical summaries', () => {
    expect(replicate(config, 30, 7)).toEqual(replicate(config, 30, 7));
  });
});

describe('conservation', () => {
  it('every customer who arrives is eventually served', () => {
    for (const prepMode of ['parallel', 'sequential'] as const) {
      for (let seed = 0; seed < 20; seed++) {
        const r = runOnce(buildConfig(busyCafe({ prepMode })), seed);
        expect(r.served).toBe(r.arrivals);
      }
    }
  });
});

describe('order routes', () => {
  // Plenty of staff so nobody queues; fixed times make every wait exact.
  const roomy = (prepMode: 'parallel' | 'sequential') =>
    busyCafe({
      staff: { cashier: 50, barista: 50, kitchen: 50, handoff: 50 },
      times: { order: fixed(1), drink: fixed(2), food: fixed(5), handoff: fixed(1) },
      foodBatching: undefined,
      prepMode,
    });

  it('parallel prep: drink + food wait = max(drink, food) + handoff', () => {
    const r = runOnce(buildConfig(roomy('parallel')), 5, { keepCustomers: true });
    for (const c of r.customers!) {
      const expected = c.type === 'drink' ? 3 : 6; // drink: 2+1; food and drink+food: 5+1
      expect(c.wait).toBeCloseTo(expected, 9);
      expect(c.orderPlaced - c.arrival).toBeCloseTo(1, 9);
    }
  });

  it('sequential prep: drink + food wait = drink + food + handoff', () => {
    const r = runOnce(buildConfig(roomy('sequential')), 5, { keepCustomers: true });
    for (const c of r.customers!) {
      const expected = c.type === 'drink' ? 3 : c.type === 'food' ? 6 : 8;
      expect(c.wait).toBeCloseTo(expected, 9);
    }
  });

  it('sequential prep gives longer drink + food waits than parallel in a busy café', () => {
    const par = replicate(buildConfig(busyCafe({ foodBatching: undefined })), 100, 11);
    const seq = replicate(buildConfig(busyCafe({ foodBatching: undefined, prepMode: 'sequential' })), 100, 11);
    expect(seq.wait.drinkFood.median.mean).toBeGreaterThan(par.wait.drinkFood.median.mean);
  });

  it('grab-and-go: the cashier hands over a ready item; no barista or kitchen time', () => {
    const spec = { ...roomy('parallel'), mix: { grabGo: 1 }, times: { order: fixed(1), drink: fixed(2), food: fixed(5), handoff: fixed(1), grab: fixed(0.3) } };
    const r = runOnce(buildConfig(spec), 9, { keepCustomers: true });
    expect(r.customers!.length).toBeGreaterThan(20);
    for (const c of r.customers!) {
      expect(c.type).toBe('grabGo');
      expect(c.wait).toBeCloseTo(0.3, 9);
    }
    expect(r.stations.barista.utilization).toBe(0);
    expect(r.stations.kitchen.utilization).toBe(0);
  });

  it('adding grab-and-go orders leaves arrival times unchanged (common random numbers)', () => {
    const a = runOnce(buildConfig(busyCafe()), 5, { keepCustomers: true });
    const b = runOnce(buildConfig(busyCafe({ mix: { drink: 0.3, food: 0.2, drinkFood: 0.3, grabGo: 0.2 } })), 5, { keepCustomers: true });
    const times = (r: typeof a) => r.customers!.map((c) => c.arrival).sort((x, y) => x - y);
    expect(times(b)).toEqual(times(a));
  });

  it('express station: drink-only orders skip the main barista', () => {
    const spec = busyCafe({
      staff: { cashier: 1, barista: 1, kitchen: 1, handoff: 1, express: 1 },
      drinkOnlyStation: 'express',
      foodBatching: undefined,
    });
    const r = runOnce(buildConfig(spec), 3);
    expect(r.stations.express.utilization).toBeGreaterThan(0);
    expect(r.served).toBe(r.arrivals);
  });
});

describe('staff schedules', () => {
  it('a station with no staff until minute 30 finishes nothing before minute 30', () => {
    const spec = busyCafe({
      staff: { cashier: 2, barista: [{ fromMin: 0, servers: 0 }, { fromMin: 30, servers: 2 }], kitchen: 1, handoff: 1 },
      foodBatching: undefined,
    });
    const r = runOnce(buildConfig(spec), 8, { keepCustomers: true });
    for (const c of r.customers!) if (c.type !== 'food') expect(c.done).toBeGreaterThanOrEqual(30);
  });

  it('adding a barista lowers drink waits', () => {
    const base = busyCafe({ staff: { cashier: 1, barista: 1, kitchen: 1, handoff: 1 }, foodBatching: undefined });
    const more = busyCafe({ staff: { cashier: 1, barista: 2, kitchen: 1, handoff: 1 }, foodBatching: undefined });
    expect(replicate(buildConfig(more), 100, 4).wait.drink.p90.mean).toBeLessThan(
      replicate(buildConfig(base), 100, 4).wait.drink.p90.mean,
    );
  });

  it('rejects invalid staff schedules', () => {
    const bad = busyCafe({ staff: { cashier: [{ fromMin: 5, servers: 1 }], barista: 1, kitchen: 1, handoff: 1 } });
    expect(() => runOnce(buildConfig(bad), 1)).toThrow(ConfigError);
  });
});

describe('food batching', () => {
  it('no food is handed over before the first batch is ready', () => {
    const r = runOnce(buildConfig(busyCafe({ foodBatching: { intervalMin: 15, batchSize: 5, cookMin: 10 } })), 21, { keepCustomers: true });
    for (const c of r.customers!) if (c.type !== 'drink') expect(c.done).toBeGreaterThanOrEqual(10);
  });

  it('leftover stock is never negative and everyone gets their food', () => {
    for (let seed = 0; seed < 20; seed++) {
      const r = runOnce(buildConfig(busyCafe()), seed);
      expect(r.stations.kitchen.leftover).toBeGreaterThanOrEqual(0);
      expect(r.served).toBe(r.arrivals);
    }
  });
});

describe('random inputs', () => {
  it('arrivals per 15-minute bucket average rate × 15 (non-homogeneous Poisson)', () => {
    const curve = { bucketMinutes: 15, ratePerMin: [0.2, 0.8, 0.4] };
    const counts = [0, 0, 0];
    const runs = 4000;
    for (let s = 0; s < runs; s++) {
      for (const t of generateArrivals(curve, new Rng(s))) counts[Math.floor(t / 15)]++;
    }
    curve.ratePerMin.forEach((rate, b) => {
      expect(Math.abs(counts[b] / runs - rate * 15) / (rate * 15)).toBeLessThan(0.03);
    });
  });

  it('lognormal sampler matches its median and mean', () => {
    const rng = new Rng(77);
    const d = lognormal(2, 0.6);
    const xs = Array.from({ length: 200_000 }, () => sample(d, rng));
    expect(Math.abs(median(xs) - 2) / 2).toBeLessThan(0.01);
    const expectedMean = 2 * Math.exp(0.18);
    expect(Math.abs(mean(xs) - expectedMean) / expectedMean).toBeLessThan(0.01);
  });
});
