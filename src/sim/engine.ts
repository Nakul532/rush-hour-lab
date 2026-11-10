// Discrete-event simulation of one rush window.
//
// How it works: every customer is pre-generated (arrival time, order type, and
// a random time for each task). An event calendar then plays the rush forward:
// arrival → each stage of the order's route → done. Stations serve jobs first
// come, first served. After the window closes no one new arrives, and the
// simulation keeps going until every order is handed over.
//
// Random-number streams are separate per purpose (arrivals, order mix, each
// task kind). Changing a config option therefore leaves customer i with the
// same arrival time and the same task times, so two configs are compared on
// identical customers ("common random numbers"), which makes comparisons sharper.

import { generateArrivals, windowMinutes } from './arrivals';
import { sample } from './distributions';
import { Fifo, MinHeap } from './heap';
import { mixSeed, Rng } from './rng';
import { quantileSorted, mean } from './stats';
import {
  ORDER_TYPES,
  TASK_KINDS,
  type BatchStation,
  type CustomerRecord,
  type OrderType,
  type RunResult,
  type ServerStation,
  type SimConfig,
  type StationStats,
  type TaskKind,
  type WaitStats,
} from './types';

interface Customer {
  id: number;
  type: OrderType;
  arrival: number;
  durations: Record<TaskKind, number>;
  stage: number;
  pending: number;
  orderPlaced: number;
  done: number;
}

interface Job {
  customer: Customer;
  task: TaskKind;
}

type SimEvent =
  | { t: number; seq: number; kind: 'arrival'; customer: Customer }
  | { t: number; seq: number; kind: 'done'; station: StationSim; job: Job }
  | { t: number; seq: number; kind: 'capacity'; station: ServerSim; servers: number }
  | { t: number; seq: number; kind: 'batchStart'; station: BatchSim }
  | { t: number; seq: number; kind: 'batchReady'; station: BatchSim };

type NewEvent = SimEvent extends infer E ? (E extends SimEvent ? Omit<E, 'seq'> : never) : never;

interface ServerSim {
  kind: 'servers';
  def: ServerStation;
  capacity: number;
  busy: number;
  queue: Fifo<Job>;
  busyArea: number;
  capArea: number;
  lastT: number;
  maxQueue: number;
}

interface BatchSim {
  kind: 'batch';
  def: BatchStation;
  stock: number;
  waiting: Fifo<Job>;
  produced: number;
  consumed: number;
  maxQueue: number;
}

type StationSim = ServerSim | BatchSim;

export class ConfigError extends Error {}

export function validateConfig(config: SimConfig): void {
  const ids = new Set<string>();
  for (const s of config.stations) {
    if (ids.has(s.id)) throw new ConfigError(`Duplicate station id "${s.id}"`);
    ids.add(s.id);
    if (s.kind === 'servers') {
      if (s.staff.length === 0 || s.staff[0].fromMin !== 0)
        throw new ConfigError(`Station "${s.id}": first staff window must start at minute 0`);
      for (let i = 0; i < s.staff.length; i++) {
        const w = s.staff[i];
        if (!Number.isInteger(w.servers) || w.servers < 0)
          throw new ConfigError(`Station "${s.id}": staff must be a whole number ≥ 0`);
        if (i > 0 && w.fromMin <= s.staff[i - 1].fromMin)
          throw new ConfigError(`Station "${s.id}": staff windows must be in time order`);
      }
    } else {
      if (!(s.intervalMin > 0) || !(s.batchSize >= 1) || !(s.cookMin >= 0))
        throw new ConfigError(`Batch station "${s.id}": interval, batch size and cook time must be positive`);
    }
  }
  const totalMix = ORDER_TYPES.reduce((a, t) => a + Math.max(0, config.mix[t] ?? 0), 0);
  if (!(totalMix > 0)) throw new ConfigError('Order mix must have at least one positive weight');
  for (const type of ORDER_TYPES) {
    if (!((config.mix[type] ?? 0) > 0)) continue;
    const flow = config.flows[type];
    if (!flow || flow.length === 0) throw new ConfigError(`No route for order type "${type}"`);
    for (const stage of flow) {
      if (stage.length === 0) throw new ConfigError(`Empty stage in route for "${type}"`);
      for (const task of stage) {
        const st = config.routing[type]?.[task];
        if (!st || !ids.has(st))
          throw new ConfigError(`Task "${task}" for "${type}" is routed to unknown station "${st}"`);
      }
    }
  }
}

function waitStats(xs: number[]): WaitStats {
  const sorted = xs.slice().sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantileSorted(sorted, 0.5),
    p90: quantileSorted(sorted, 0.9),
    mean: mean(sorted),
  };
}

export interface RunOptions {
  /** Include every customer's times in the result (for calibration and tests). */
  keepCustomers?: boolean;
}

/** Run one replication of the rush with the given seed. */
export function runOnce(config: SimConfig, seed: number, options: RunOptions = {}): RunResult {
  validateConfig(config);
  const windowMin = windowMinutes(config.arrivals);
  const measureFrom = config.measureFromMin ?? 0;

  // ---- Pre-generate customers (separate random streams per purpose) ----
  const arrivalRng = new Rng(mixSeed(seed, 1));
  const mixRng = new Rng(mixSeed(seed, 2));
  const taskRng: Record<TaskKind, Rng> = {
    order: new Rng(mixSeed(seed, 10)),
    drink: new Rng(mixSeed(seed, 11)),
    food: new Rng(mixSeed(seed, 12)),
    handoff: new Rng(mixSeed(seed, 13)),
    grab: new Rng(mixSeed(seed, 14)),
  };
  const weights = ORDER_TYPES.map((t) => Math.max(0, config.mix[t] ?? 0));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const pickType = (): OrderType => {
    let u = mixRng.next() * totalWeight;
    for (let i = 0; i < ORDER_TYPES.length; i++) {
      u -= weights[i];
      if (u < 0) return ORDER_TYPES[i];
    }
    for (let i = ORDER_TYPES.length - 1; i >= 0; i--) if (weights[i] > 0) return ORDER_TYPES[i];
    return ORDER_TYPES[0];
  };

  const customers: Customer[] = generateArrivals(config.arrivals, arrivalRng).map((arrival, id) => {
    const type = pickType();
    // Always draw every task time, even unused ones, so the streams stay aligned
    // across configs (common random numbers).
    const durations = {} as Record<TaskKind, number>;
    for (const k of TASK_KINDS) durations[k] = sample(config.taskTimes[k], taskRng[k]);
    return { id, type, arrival, durations, stage: -1, pending: 0, orderPlaced: NaN, done: NaN };
  });

  // ---- Stations ----
  const stations = new Map<string, StationSim>();
  for (const def of config.stations) {
    if (def.kind === 'servers') {
      stations.set(def.id, {
        kind: 'servers', def, capacity: def.staff[0].servers, busy: 0, queue: new Fifo(),
        busyArea: 0, capArea: 0, lastT: 0, maxQueue: 0,
      });
    } else {
      stations.set(def.id, {
        kind: 'batch', def, stock: 0, waiting: new Fifo(), produced: 0, consumed: 0, maxQueue: 0,
      });
    }
  }

  // ---- Event calendar ----
  let seq = 0;
  const calendar = new MinHeap<SimEvent>((a, b) => (a.t < b.t || (a.t === b.t && a.seq < b.seq)));
  const schedule = (e: NewEvent) => calendar.push({ ...e, seq: seq++ } as SimEvent);

  for (const c of customers) schedule({ t: c.arrival, kind: 'arrival', customer: c });
  for (const st of stations.values()) {
    if (st.kind === 'servers') {
      for (const w of st.def.staff.slice(1)) schedule({ t: w.fromMin, kind: 'capacity', station: st, servers: w.servers });
    } else {
      schedule({ t: st.def.firstStartMin, kind: 'batchStart', station: st });
    }
  }

  // ---- State for Little's law ----
  let inSystem = 0;
  let areaN = 0;
  let lastAreaT = 0;
  let arrivalsLeft = customers.length;
  let lastCustomerEventT = 0;

  const touchServer = (st: ServerSim, t: number) => {
    const dt = t - st.lastT;
    st.busyArea += st.busy * dt;
    st.capArea += st.capacity * dt;
    st.lastT = t;
  };

  const dispatch = (st: ServerSim, t: number) => {
    while (st.busy < st.capacity && st.queue.length > 0) {
      const job = st.queue.shift() as Job;
      st.busy++;
      schedule({ t: t + job.customer.durations[job.task], kind: 'done', station: st, job });
    }
  };

  const enqueue = (job: Job, t: number) => {
    const stationId = config.routing[job.customer.type]![job.task] as string;
    const st = stations.get(stationId) as StationSim;
    if (st.kind === 'servers') {
      touchServer(st, t);
      st.queue.push(job);
      dispatch(st, t);
      st.maxQueue = Math.max(st.maxQueue, st.queue.length);
    } else if (st.stock > 0) {
      st.stock--;
      st.consumed++;
      schedule({ t, kind: 'done', station: st, job });
    } else {
      st.waiting.push(job);
      st.maxQueue = Math.max(st.maxQueue, st.waiting.length);
    }
  };

  const records: CustomerRecord[] = [];

  const startStage = (c: Customer, t: number) => {
    const flow = config.flows[c.type]!;
    c.stage++;
    if (c.stage >= flow.length) {
      c.done = t;
      if (Number.isNaN(c.orderPlaced)) c.orderPlaced = c.arrival;
      inSystem--;
      records.push({ type: c.type, arrival: c.arrival, orderPlaced: c.orderPlaced, done: c.done, wait: c.done - c.orderPlaced });
      return;
    }
    const tasks = flow[c.stage];
    c.pending = tasks.length;
    for (const task of tasks) enqueue({ customer: c, task }, t);
  };

  for (;;) {
    const ev = calendar.pop();
    if (!ev) break;
    const customersFinished = arrivalsLeft === 0 && inSystem === 0;
    if (customersFinished && ev.t > Math.max(windowMin, lastCustomerEventT)) break;

    areaN += inSystem * (ev.t - lastAreaT);
    lastAreaT = ev.t;
    const t = ev.t;

    switch (ev.kind) {
      case 'arrival': {
        arrivalsLeft--;
        inSystem++;
        lastCustomerEventT = t;
        startStage(ev.customer, t);
        break;
      }
      case 'done': {
        const st = ev.station;
        if (st.kind === 'servers') {
          touchServer(st, t);
          st.busy--;
          dispatch(st, t);
        }
        lastCustomerEventT = t;
        const c = ev.job.customer;
        if (ev.job.task === 'order') c.orderPlaced = t;
        c.pending--;
        if (c.pending === 0) startStage(c, t);
        break;
      }
      case 'capacity': {
        const st = ev.station;
        touchServer(st, t);
        st.capacity = ev.servers;
        dispatch(st, t);
        break;
      }
      case 'batchStart': {
        const st = ev.station;
        schedule({ t: t + st.def.cookMin, kind: 'batchReady', station: st });
        const next = t + st.def.intervalMin;
        if (next < windowMin || inSystem > 0 || arrivalsLeft > 0) schedule({ t: next, kind: 'batchStart', station: st });
        break;
      }
      case 'batchReady': {
        const st = ev.station;
        st.stock += st.def.batchSize;
        st.produced += st.def.batchSize;
        while (st.stock > 0 && st.waiting.length > 0) {
          st.stock--;
          st.consumed++;
          schedule({ t, kind: 'done', station: st, job: st.waiting.shift() as Job });
        }
        break;
      }
    }
  }

  const endMin = Math.max(windowMin, lastCustomerEventT);
  areaN += inSystem * (endMin - lastAreaT);

  // ---- Results ----
  const stationStats: Record<string, StationStats> = {};
  for (const [id, st] of stations) {
    if (st.kind === 'servers') {
      touchServer(st, endMin);
      stationStats[id] = { utilization: st.capArea > 0 ? st.busyArea / st.capArea : null, maxQueue: st.maxQueue };
    } else {
      stationStats[id] = { utilization: null, maxQueue: st.maxQueue, leftover: st.produced - st.consumed };
    }
  }

  const measured = records.filter((r) => r.arrival >= measureFrom);
  const wait = {} as Record<OrderType | 'all', WaitStats>;
  for (const type of ORDER_TYPES) wait[type] = waitStats(measured.filter((r) => r.type === type).map((r) => r.wait));
  wait.all = waitStats(measured.map((r) => r.wait));

  const totalSojourn = records.reduce((a, r) => a + (r.done - r.arrival), 0);
  return {
    arrivals: customers.length,
    served: records.length,
    servedInWindow: records.filter((r) => r.done <= windowMin).length,
    windowMin,
    endMin,
    wait,
    timeInSystem: waitStats(measured.map((r) => r.done - r.arrival)),
    stations: stationStats,
    little: {
      L: endMin > 0 ? areaN / endMin : 0,
      lambda: endMin > 0 ? records.length / endMin : 0,
      W: records.length > 0 ? totalSojourn / records.length : NaN,
    },
    ...(options.keepCustomers ? { customers: records } : {}),
  };
}
