// A café described in everyday terms, turned into an engine config.
// These are the options the agent will change in Stage 2.

import { lognormal, type Dist } from './distributions';
import type { ArrivalCurve, OrderType, SimConfig, StaffWindow, Station, TaskKind } from './types';

/** A fixed head count, or a schedule like [{fromMin:0,servers:1},{fromMin:60,servers:2}]. */
export type Staffing = number | StaffWindow[];

export interface CafeSpec {
  name: string;
  arrivals: ArrivalCurve;
  /** Relative weights per order type; missing types have weight 0. */
  mix: Partial<Record<OrderType, number>>;
  staff: {
    cashier: Staffing;
    barista: Staffing;
    /** Ignored when foodBatching is set (the batch schedule replaces the cook queue). */
    kitchen: Staffing;
    /** Required when handoff is 'dedicated'. */
    handoff?: Staffing;
    /** Optional second drink station, used with drinkOnlyStation: 'express'. */
    express?: Staffing;
  };
  /** Minutes per task: order (at the cashier), drink, food, handoff, and grab (ready item; default median 0.3 min). */
  times: Record<Exclude<TaskKind, 'grab'>, Dist> & { grab?: Dist };
  /** For drink + food orders: make both at once, or drink first then food. */
  prepMode: 'parallel' | 'sequential';
  /** Who hands orders over: the barista, or a dedicated handoff person. */
  handoff: 'barista' | 'dedicated';
  /** Make food to stock in batches instead of to order. */
  foodBatching?: { intervalMin: number; batchSize: number; cookMin: number; firstStartMin?: number };
  /** Order-type routing: send drink-only orders to an express drink station. */
  drinkOnlyStation?: 'barista' | 'express';
  /** Warm-up: ignore customers who arrive before this minute in wait statistics. */
  measureFromMin?: number;
}

/** Near-zero time to hand over a ready item. ASSUMPTION. */
export const DEFAULT_GRAB_TIME: Dist = lognormal(0.3, 0.5);

function toWindows(s: Staffing): StaffWindow[] {
  return typeof s === 'number' ? [{ fromMin: 0, servers: s }] : s;
}

export function buildConfig(spec: CafeSpec): SimConfig {
  const stations: Station[] = [
    { kind: 'servers', id: 'cashier', staff: toWindows(spec.staff.cashier) },
    { kind: 'servers', id: 'barista', staff: toWindows(spec.staff.barista) },
  ];
  if (spec.foodBatching) {
    const b = spec.foodBatching;
    stations.push({
      kind: 'batch', id: 'kitchen', intervalMin: b.intervalMin, batchSize: b.batchSize,
      cookMin: b.cookMin, firstStartMin: b.firstStartMin ?? 0,
    });
  } else {
    stations.push({ kind: 'servers', id: 'kitchen', staff: toWindows(spec.staff.kitchen) });
  }
  if (spec.handoff === 'dedicated') {
    if (spec.staff.handoff === undefined) throw new Error('handoff is "dedicated" but staff.handoff is not set');
    stations.push({ kind: 'servers', id: 'handoff', staff: toWindows(spec.staff.handoff) });
  }
  if (spec.drinkOnlyStation === 'express') {
    if (spec.staff.express === undefined) throw new Error('drinkOnlyStation is "express" but staff.express is not set');
    stations.push({ kind: 'servers', id: 'express', staff: toWindows(spec.staff.express) });
  }

  const handoffStation = spec.handoff === 'dedicated' ? 'handoff' : 'barista';
  const drinkOnlyStation = spec.drinkOnlyStation === 'express' ? 'express' : 'barista';

  return {
    arrivals: spec.arrivals,
    mix: spec.mix,
    stations,
    taskTimes: { ...spec.times, grab: spec.times.grab ?? DEFAULT_GRAB_TIME },
    routing: {
      drink: { order: 'cashier', drink: drinkOnlyStation, handoff: spec.drinkOnlyStation === 'express' ? drinkOnlyStation : handoffStation },
      food: { order: 'cashier', food: 'kitchen', handoff: handoffStation },
      drinkFood: { order: 'cashier', drink: 'barista', food: 'kitchen', handoff: handoffStation },
      // The cashier hands over ready items, in line with everyone else.
      grabGo: { order: 'cashier', grab: 'cashier' },
    },
    flows: {
      drink: [['order'], ['drink'], ['handoff']],
      food: [['order'], ['food'], ['handoff']],
      drinkFood:
        spec.prepMode === 'parallel'
          ? [['order'], ['drink', 'food'], ['handoff']]
          : [['order'], ['drink'], ['food'], ['handoff']],
      grabGo: [['order'], ['grab']],
    },
    measureFromMin: spec.measureFromMin,
  };
}
