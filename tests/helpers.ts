import { constantCurve } from '../src/sim/arrivals';
import type { Dist } from '../src/sim/distributions';
import type { SimConfig } from '../src/sim/types';

const zero: Dist = { kind: 'fixed', value: 0 };

/** One station with `servers` staff and exponential service: an M/M/c queue. */
export function mmcConfig(lambda: number, mu: number, servers: number, minutes: number, warmupMin: number): SimConfig {
  return {
    arrivals: constantCurve(lambda, minutes, minutes),
    mix: { drink: 1, food: 0, drinkFood: 0 },
    stations: [{ kind: 'servers', id: 'counter', staff: [{ fromMin: 0, servers }] }],
    taskTimes: { order: { kind: 'exponential', mean: 1 / mu }, drink: zero, food: zero, handoff: zero, grab: zero },
    routing: { drink: { order: 'counter' }, food: {}, drinkFood: {} },
    flows: { drink: [['order']], food: [], drinkFood: [] },
    measureFromMin: warmupMin,
  };
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

/** Textbook M/M/c results (Erlang C). For c = 1 these reduce to the M/M/1 formulas. */
export function mmcTheory(lambda: number, mu: number, c: number) {
  const a = lambda / mu;
  const rho = a / c;
  let sum = 0;
  for (let k = 0; k < c; k++) sum += a ** k / factorial(k);
  const top = a ** c / factorial(c) / (1 - rho);
  const pWait = top / (sum + top);
  const Wq = pWait / (c * mu - lambda);
  const W = Wq + 1 / mu;
  return { rho, pWait, Wq, W, L: lambda * W };
}
