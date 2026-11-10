// Stage 3b: five "interacting changes" scenarios. LOCKED before brute force,
// greedy or the LLM agent ran on them. All cafés are SYNTHETIC.
//
// Designed with single-change and intended-pair probes only (disclosed in
// PROTOCOL.md). Two mechanisms:
// - superadditive (I1–I3): each fix alone helps a little; together they help
//   far more. Greedy can still find these by taking the small single gain first.
// - budget trap (I4–I5): the best single change uses up the budget, so greedy
//   takes it and is stuck; the best plan is two cheaper changes together.

import { constantCurve } from '../src/sim/arrivals';
import type { CafeSpec } from '../src/sim/cafe';
import { lognormal } from '../src/sim/distributions';
import type { Change, StationName } from '../src/agent/changes';
import { spaceSize } from '../src/agent/space';
import type { Scenario } from './scenarios';

export interface InteractingScenario extends Scenario {
  mechanism: 'superadditive' | 'budget trap';
}

function cafe(name: string, o: { rate?: number; curve?: number[]; mix: CafeSpec['mix']; staff?: CafeSpec['staff']; drink: number; food: number }): CafeSpec {
  return {
    name,
    arrivals: o.curve ? { bucketMinutes: 15, ratePerMin: o.curve } : constantCurve(o.rate ?? 0.7, 90),
    mix: o.mix,
    staff: o.staff ?? { cashier: 1, barista: 1, kitchen: 1, handoff: 1 },
    times: { order: lognormal(0.8, 0.4), drink: lognormal(o.drink, 0.4), food: lognormal(o.food, 0.4), handoff: lognormal(0.3, 0.4) },
    prepMode: 'parallel',
    handoff: 'dedicated',
    startsAt: '07:00',
  };
}
const staff = (station: StationName, delta = 1, fromMin?: number, toMin?: number): Change => ({
  kind: 'staff', station, delta, ...(fromMin !== undefined ? { fromMin } : {}), ...(toMin !== undefined ? { toMin } : {}),
});
const opt = (label: string, ...changes: Change[]) => ({ label, changes });
const combined = { drink: 0, food: 0, drinkFood: 100 };
const peakCurve = (s: number) => [0.4, 0.6, 0.9, 1.0, 0.9, 0.6].map((x) => x * s);

export const INTERACTING: InteractingScenario[] = [
  {
    id: 'I1', title: 'Twin bottleneck, max 2 changes', mechanism: 'superadditive', provenance: 'SYNTHETIC',
    why: 'Every order is drink + food made in parallel, so it waits for the slower of barista and kitchen. Relieving one alone helps a little; both, a lot.',
    spec: cafe('I1', { rate: 0.7, mix: combined, drink: 1.25, food: 1.25 }),
    constraints: { maxChanges: 2 },
    space: [
      { id: 'barista', label: 'More barista', options: [opt('+1 barista', staff('barista')), opt('+1 barista 07:30–08:00', staff('barista', 1, 30, 60))] },
      { id: 'kitchen', label: 'More kitchen', options: [opt('+1 kitchen', staff('kitchen')), opt('+1 kitchen 07:30–08:00', staff('kitchen', 1, 30, 60))] },
      { id: 'cashier', label: 'More cashier', options: [opt('+1 cashier', staff('cashier'))] },
      { id: 'grab', label: 'Grab-and-go', options: [opt('grab-and-go 30%', { kind: 'grabGo', shareOfDrinks: 0.3 })] },
    ],
  },
  {
    id: 'I2', title: 'Twin bottleneck, no new hires, three on the register', mechanism: 'superadditive', provenance: 'SYNTHETIC',
    why: 'Same twin bottleneck; two spare people on the register can move to the bar and the kitchen, but each move alone helps little.',
    spec: cafe('I2', { rate: 0.65, mix: combined, drink: 1.3, food: 1.3, staff: { cashier: 3, barista: 1, kitchen: 1, handoff: 1 } }),
    constraints: { noNewHires: true },
    space: [
      { id: 'to-barista', label: 'Register to bar', options: [opt('cashier → barista', staff('cashier', -1), staff('barista', 1))] },
      { id: 'to-kitchen', label: 'Register to kitchen', options: [opt('cashier → kitchen', staff('cashier', -1), staff('kitchen', 1))] },
      { id: 'hire', label: 'Hire', options: [opt('+1 barista (hire)', staff('barista')), opt('+1 kitchen (hire)', staff('kitchen'))] },
      { id: 'grab', label: 'Grab-and-go', options: [opt('grab-and-go 30%', { kind: 'grabGo', shareOfDrinks: 0.3 })] },
    ],
  },
  {
    id: 'I3', title: 'Twin bottleneck at the peak, $500 budget', mechanism: 'superadditive', provenance: 'SYNTHETIC',
    why: 'Short peak; a 30-minute extra at the bar or kitchen alone barely moves the bad-case wait; both together do.',
    spec: cafe('I3', { curve: peakCurve(0.79), mix: combined, drink: 1.25, food: 1.25 }),
    constraints: { budgetUsd: 500 },
    space: [
      { id: 'barista', label: 'Peak barista', options: [opt('+1 barista 07:30–08:00', staff('barista', 1, 30, 60))] },
      { id: 'kitchen', label: 'Peak kitchen', options: [opt('+1 kitchen 07:30–08:00', staff('kitchen', 1, 30, 60))] },
      { id: 'cashier', label: 'Peak cashier', options: [opt('+1 cashier 07:30–08:00', staff('cashier', 1, 30, 60))] },
      { id: 'grab', label: 'Grab-and-go', options: [opt('grab-and-go 30%', { kind: 'grabGo', shareOfDrinks: 0.3 })] },
    ],
  },
  {
    id: 'I4', title: 'Budget trap: whole-rush barista vs two peak extras, $700', mechanism: 'budget trap', provenance: 'SYNTHETIC',
    why: 'A whole-rush barista ($660) is the best single change but leaves no budget; a peak barista plus a peak cook ($440) together beat it.',
    spec: cafe('I4', { curve: [0.5, 0.7, 0.9, 0.9, 0.7, 0.5].map((x) => x * 0.8), mix: { drink: 25, food: 0, drinkFood: 75 }, drink: 1.25, food: 1.45 }),
    constraints: { budgetUsd: 700 },
    space: [
      { id: 'barista', label: 'More barista', options: [opt('+1 barista whole rush', staff('barista')), opt('+1 barista 07:30–08:00', staff('barista', 1, 30, 60))] },
      { id: 'kitchen', label: 'Peak kitchen', options: [opt('+1 kitchen 07:30–08:00', staff('kitchen', 1, 30, 60))] },
      { id: 'grab', label: 'Grab-and-go', options: [opt('grab-and-go 30%', { kind: 'grabGo', shareOfDrinks: 0.3 })] },
      { id: 'cashier', label: 'Peak cashier', options: [opt('+1 cashier 07:30–08:00', staff('cashier', 1, 30, 60))] },
    ],
  },
  {
    id: 'I5', title: 'Budget trap at a twin peak, $660', mechanism: 'budget trap', provenance: 'SYNTHETIC',
    why: 'All orders are combined; a whole-rush barista uses the whole budget, while two 30-minute extras (bar and kitchen) cost less and help more.',
    spec: cafe('I5', { curve: peakCurve(0.79), mix: combined, drink: 1.25, food: 1.25 }),
    constraints: { budgetUsd: 660 },
    space: [
      { id: 'barista', label: 'More barista', options: [opt('+1 barista whole rush', staff('barista')), opt('+1 barista 07:30–08:00', staff('barista', 1, 30, 60))] },
      { id: 'kitchen', label: 'More kitchen', options: [opt('+1 kitchen whole rush', staff('kitchen')), opt('+1 kitchen 07:30–08:00', staff('kitchen', 1, 30, 60))] },
      { id: 'grab', label: 'Grab-and-go', options: [opt('grab-and-go 30%', { kind: 'grabGo', shareOfDrinks: 0.3 })] },
    ],
  },
];

for (const s of INTERACTING) {
  const n = spaceSize(s.space);
  if (n > 300) throw new Error(`${s.id} has ${n} plans; the limit is 300`);
}
