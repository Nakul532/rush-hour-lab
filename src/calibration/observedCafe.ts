// The model of Nakul's café used for calibration, and the assumptions behind it.
// Only drink time, food time, their spread and the prep mode are fitted.
// Everything else is an ASSUMPTION, a PUBLISHED BENCHMARK, or counted from the
// OBSERVED orders, listed here.

import { constantCurve } from '../sim/arrivals';
import { buildConfig, type CafeSpec } from '../sim/cafe';
import { lognormal } from '../sim/distributions';
import { mean, median } from '../sim/stats';
import type { OrderType, SimConfig } from '../sim/types';
import type { ObservedOrder, ObservedType } from '../data/observed';

export interface FitParams {
  /** Median barista time per made drink, minutes. */
  drinkMedian: number;
  /** Median kitchen time per food order, minutes. */
  foodMedian: number;
  /** Lognormal spread for drink and food times (shared). */
  sigma: number;
  prepMode: 'parallel' | 'sequential';
}

/** Drink-only orders that took at most this long are counted as grab-and-go items. */
export const GRAB_GO_MAX_WAIT = 3;

export const ASSUMPTIONS = {
  staff: 'ASSUMPTION: 1 cashier, 1 barista, 1 kitchen person; the barista hands over orders. Staffing was not recorded.',
  orderTime:
    'PUBLISHED BENCHMARK (approx.): order taking ~1 min, between City Observatory (30–40 s placement) and Curio (order 1 min + entry 1–2 min). Lognormal, median 1.0, spread 0.5.',
  handoffTime: 'ASSUMPTION: handoff median 0.5 min, spread 0.5.',
  window: 'ASSUMPTION: steady traffic for 120 min; customers arriving in the first 30 min are a warm-up and not measured.',
  arrivalRate:
    "ASSUMPTION via Little's law: arrival rate = typical people in queue (median 3, OBSERVED, 17 usable counts) ÷ mean observed wait (8.33 min, OBSERVED) ≈ 0.36 per minute.",
  mix: 'OBSERVED: order mix from the 18 orders (9 drink, 4 food, 5 drink + food).',
  grabGo: `ASSUMPTION (grab-and-go model only): drink-only orders with waits of ${GRAB_GO_MAX_WAIT} min or less are ready items (drip coffee etc.) that the cashier hands over in ~0.3 min. That is 4 of the 9 drink orders.`,
} as const;

export const WINDOW_MIN = 120;
export const WARMUP_MIN = 30;

/** Which column of the observation log a simulated order would have been logged in. */
export function observedCategory(type: OrderType): ObservedType {
  return type === 'grabGo' ? 'drink' : type;
}

/** Arrival rate implied by Little's law: L / W, using the queue counts and waits. */
export function littleLawArrivalRate(orders: readonly ObservedOrder[]): number {
  const counts = orders.map((o) => o.queueCount).filter((q): q is number => q !== null);
  return median(counts) / mean(orders.map((o) => o.waitMin));
}

/** Order mix counted from the observed orders. With `grabGo`, short drink waits become grab-and-go orders. */
export function observedMix(orders: readonly ObservedOrder[], grabGo = false): Partial<Record<OrderType, number>> {
  const of = (t: ObservedType) => orders.filter((o) => o.type === t);
  const drinks = of('drink');
  const grab = grabGo ? drinks.filter((o) => o.waitMin <= GRAB_GO_MAX_WAIT).length : 0;
  return { drink: drinks.length - grab, food: of('food').length, drinkFood: of('drinkFood').length, grabGo: grab };
}

export function observedCafeSpec(p: FitParams, ratePerMin: number, mix: CafeSpec['mix']): CafeSpec {
  return {
    name: 'Observed café (Bay Area, calibrated)',
    arrivals: constantCurve(ratePerMin, WINDOW_MIN),
    mix,
    staff: { cashier: 1, barista: 1, kitchen: 1 },
    times: {
      order: lognormal(1.0, 0.5),
      drink: lognormal(p.drinkMedian, p.sigma),
      food: lognormal(p.foodMedian, p.sigma),
      handoff: lognormal(0.5, 0.5),
    },
    prepMode: p.prepMode,
    handoff: 'barista',
    measureFromMin: WARMUP_MIN,
  };
}

export function observedCafeConfig(p: FitParams, ratePerMin: number, mix: CafeSpec['mix']): SimConfig {
  return buildConfig(observedCafeSpec(p, ratePerMin, mix));
}
