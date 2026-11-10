import { runOnce } from './engine';
import { mixSeed } from './rng';
import { meanCI, type Interval } from './stats';
import { ORDER_TYPES, type OrderType, type RunResult, type SimConfig } from './types';

export interface ReplicationSummary {
  reps: number;
  seed: number;
  /** Per order type (and 'all'): the median and 90th-percentile wait, mean across replications with 95% CI. */
  wait: Record<OrderType | 'all', { median: Interval; p90: Interval; count: Interval }>;
  ordersServed: Interval;
  ordersServedInWindow: Interval;
  stations: Record<string, { utilization: Interval; maxQueue: Interval; leftover?: Interval }>;
  provenance: 'SIMULATED';
}

/** Seed used for replication i. Exposed so tests and calibration can reuse it. */
export function replicationSeed(seed: number, i: number): number {
  return mixSeed(seed, 0x5eed, i);
}

export function runReplications(config: SimConfig, reps: number, seed: number): RunResult[] {
  const out: RunResult[] = [];
  for (let i = 0; i < reps; i++) out.push(runOnce(config, replicationSeed(seed, i)));
  return out;
}

/**
 * Run `reps` replications with a fixed base seed and report each metric as a
 * mean with a 95% confidence interval. The interval reflects simulation noise
 * only, not how well the model matches a real café.
 */
export function replicate(config: SimConfig, reps: number, seed: number): ReplicationSummary {
  return summarize(runReplications(config, reps, seed), seed);
}

export function summarize(runs: RunResult[], seed: number): ReplicationSummary {
  const keys = [...ORDER_TYPES, 'all'] as const;
  const wait = {} as ReplicationSummary['wait'];
  for (const k of keys) {
    wait[k] = {
      median: meanCI(runs.map((r) => r.wait[k].median)),
      p90: meanCI(runs.map((r) => r.wait[k].p90)),
      count: meanCI(runs.map((r) => r.wait[k].n)),
    };
  }
  const stations: ReplicationSummary['stations'] = {};
  for (const id of Object.keys(runs[0]?.stations ?? {})) {
    const util = runs.map((r) => r.stations[id].utilization ?? NaN);
    const entry: ReplicationSummary['stations'][string] = {
      utilization: meanCI(util),
      maxQueue: meanCI(runs.map((r) => r.stations[id].maxQueue)),
    };
    if (runs[0].stations[id].leftover !== undefined) entry.leftover = meanCI(runs.map((r) => r.stations[id].leftover ?? NaN));
    stations[id] = entry;
  }
  return {
    reps: runs.length,
    seed,
    wait,
    ordersServed: meanCI(runs.map((r) => r.served)),
    ordersServedInWindow: meanCI(runs.map((r) => r.servedInWindow)),
    stations,
    provenance: 'SIMULATED',
  };
}
