import type { Dist } from './distributions';

/** grabGo = ready item handed over at the counter (drip coffee, a ready pastry). */
export type OrderType = 'drink' | 'food' | 'drinkFood' | 'grabGo';
export const ORDER_TYPES: readonly OrderType[] = ['drink', 'food', 'drinkFood', 'grabGo'];
export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  drink: 'Drink only',
  food: 'Food only',
  drinkFood: 'Drink + food',
  grabGo: 'Grab-and-go',
};

/** The jobs an order can need. `order` = taking the order at the cashier; `grab` = handing over a ready item. */
export type TaskKind = 'order' | 'drink' | 'food' | 'handoff' | 'grab';
export const TASK_KINDS: readonly TaskKind[] = ['order', 'drink', 'food', 'handoff', 'grab'];

/** From `fromMin` onward the station has `servers` staff (until the next window). */
export interface StaffWindow {
  fromMin: number;
  servers: number;
}

/** A station where staff serve jobs one at a time, first come first served. */
export interface ServerStation {
  kind: 'servers';
  id: string;
  /** Sorted by fromMin; the first window must start at 0. */
  staff: StaffWindow[];
}

/**
 * A make-to-stock station (e.g. waffles cooked in batches). A batch of
 * `batchSize` starts every `intervalMin` minutes from `firstStartMin` and is
 * ready `cookMin` later. Orders take an item from stock, or wait for the next batch.
 */
export interface BatchStation {
  kind: 'batch';
  id: string;
  intervalMin: number;
  batchSize: number;
  cookMin: number;
  firstStartMin: number;
}

export type Station = ServerStation | BatchStation;

/** Arrival rate (customers per minute), constant within each bucket. */
export interface ArrivalCurve {
  bucketMinutes: number;
  ratePerMin: number[];
}

/**
 * Engine-level configuration. Most callers build this from a CafeSpec
 * (see cafe.ts) instead of writing it by hand.
 */
export interface SimConfig {
  arrivals: ArrivalCurve;
  /** Relative weights of each order type (need not sum to 1). Missing types have weight 0. */
  mix: Partial<Record<OrderType, number>>;
  stations: Station[];
  taskTimes: Record<TaskKind, Dist>;
  /** Which station does each task, per order type. */
  routing: Partial<Record<OrderType, Partial<Record<TaskKind, string>>>>;
  /**
   * The route of each order type as stages. Tasks inside a stage run at the
   * same time; the next stage starts when all of them are done.
   */
  flows: Partial<Record<OrderType, TaskKind[][]>>;
  /** Only customers arriving at or after this minute count in wait statistics (warm-up). */
  measureFromMin?: number;
}

export interface WaitStats {
  n: number;
  median: number;
  p90: number;
  mean: number;
}

export interface StationStats {
  /** Busy staff-time / available staff-time. null for batch stations. */
  utilization: number | null;
  /** Most jobs waiting (not yet being served) at once. */
  maxQueue: number;
  /** Batch stations only: items made but never sold (waste). */
  leftover?: number;
}

export interface CustomerRecord {
  type: OrderType;
  arrival: number;
  orderPlaced: number;
  done: number;
  /** Minutes from order placed to order received. */
  wait: number;
}

export interface RunResult {
  arrivals: number;
  served: number;
  /** Orders never handed over (a station had no staff left). Should be 0. */
  unserved: number;
  /** Orders finished before the rush window ended. */
  servedInWindow: number;
  windowMin: number;
  /** Time the last order was handed over (or window end, if later). */
  endMin: number;
  /** "Wait" = order placed → order received, for measured customers. */
  wait: Record<OrderType | 'all', WaitStats>;
  /** Arrival → order received, for measured customers. */
  timeInSystem: WaitStats;
  stations: Record<string, StationStats>;
  /**
   * Little's law bookkeeping over [0, endMin], all customers.
   * L is the time-average number in the café, tracked from events.
   */
  little: { L: number; lambda: number; W: number };
  customers?: CustomerRecord[];
}
