// Stage 3 evaluation scenarios. LOCKED: committed before any agent was run
// on them. All cafés are SYNTHETIC (invented for testing) except S10
// (calibrated observed café) and S09 (based on the reconstructed Curio preset).
//
// Each scenario has a café, the owner's constraints, and a small change
// space (≤ 300 plans) so brute force can find the truly best plan.

import { constantCurve } from '../src/sim/arrivals';
import type { CafeSpec } from '../src/sim/cafe';
import { lognormal } from '../src/sim/distributions';
import type { Change, StationName } from '../src/agent/changes';
import type { Constraints } from '../src/agent/plan';
import { spaceSize, type ChangeSpace, type Lever } from '../src/agent/space';
import { curioPreset } from '../src/presets/curio';
import { observedCafePreset } from '../src/presets/observedCafe';

export interface Scenario {
  id: string;
  title: string;
  /** What the scenario is meant to test. */
  why: string;
  provenance: 'SYNTHETIC' | 'OBSERVED-CALIBRATED' | 'RECONSTRUCTED';
  spec: CafeSpec;
  constraints: Constraints;
  space: ChangeSpace;
}

// ---- café builder ----
interface CafeOpts {
  ratePerMin?: number;
  curve?: number[];
  minutes?: number;
  mix?: CafeSpec['mix'];
  staff?: CafeSpec['staff'];
  order?: number;
  drink?: number;
  food?: number;
  handoff?: number;
  prepMode?: CafeSpec['prepMode'];
  startsAt?: string;
}
function cafe(name: string, o: CafeOpts): CafeSpec {
  const sigma = 0.4;
  return {
    name,
    arrivals: o.curve ? { bucketMinutes: 15, ratePerMin: o.curve } : constantCurve(o.ratePerMin ?? 0.6, o.minutes ?? 90),
    mix: o.mix ?? { drink: 50, food: 20, drinkFood: 30 },
    staff: o.staff ?? { cashier: 1, barista: 1, kitchen: 1 },
    times: {
      order: lognormal(o.order ?? 0.8, sigma),
      drink: lognormal(o.drink ?? 1.3, sigma),
      food: lognormal(o.food ?? 2.5, sigma),
      handoff: lognormal(o.handoff ?? 0.3, sigma),
    },
    prepMode: o.prepMode ?? 'parallel',
    handoff: 'barista',
    startsAt: o.startsAt ?? '07:00',
  };
}
const peaked = (scale: number) => [0.4, 0.7, 1.0, 1.1, 0.9, 0.6, 0.4, 0.3].map((r) => r * scale);
const twoPeaks = (scale: number) => [0.8, 1.0, 0.7, 0.3, 0.3, 0.7, 1.0, 0.8].map((r) => r * scale);

// ---- lever builders ----
const staff = (station: StationName, delta = 1, fromMin?: number, toMin?: number): Change => ({
  kind: 'staff', station, delta, ...(fromMin !== undefined ? { fromMin } : {}), ...(toMin !== undefined ? { toMin } : {}),
});
const add = (station: StationName, extra: Array<[string, Change[]]> = []): Lever => ({
  id: `add-${station}`,
  label: `More ${station} staff`,
  options: [{ label: `+1 ${station}`, changes: [staff(station)] }, ...extra.map(([label, changes]) => ({ label, changes }))],
});
const move = (from: StationName, to: StationName): Lever => ({
  id: `move-${from}-${to}`,
  label: `Move a person from ${from} to ${to}`,
  options: [{ label: `${from} → ${to}`, changes: [staff(from, -1), staff(to, 1)] }],
});
const prep = (mode: 'parallel' | 'sequential'): Lever => ({ id: 'prep', label: 'Prep mode', options: [{ label: `${mode} prep`, changes: [{ kind: 'prepMode', mode }] }] });
const handoff = (): Lever => ({ id: 'handoff', label: 'Handoff point', options: [{ label: 'dedicated handoff (1)', changes: [{ kind: 'dedicatedHandoff', staff: 1 }] }] });
const express = (): Lever => ({ id: 'express', label: 'Express drink station', options: [{ label: 'express drinks (1)', changes: [{ kind: 'expressDrinks', staff: 1 }] }] });
const grab = (...shares: number[]): Lever => ({
  id: 'grab', label: 'Grab-and-go', options: shares.map((s) => ({ label: `grab-and-go ${Math.round(s * 100)}%`, changes: [{ kind: 'grabGo', shareOfDrinks: s }] })),
});
const batching = (...opts: Array<[number, number]>): Lever => ({
  id: 'batching', label: 'Food batching', options: opts.map(([i, b]) => ({ label: `batches of ${b} every ${i} min`, changes: [{ kind: 'foodBatching', intervalMin: i, batchSize: b }] })),
});

// ---- the 15 scenarios ----
export const SCENARIOS: Scenario[] = [
  {
    id: 'S01', title: 'Barista-bound, one change allowed', provenance: 'SYNTHETIC',
    why: 'Clear bottleneck; checks the agent fixes it rather than a cheaper distraction.',
    spec: cafe('S01', {}),
    constraints: { maxChanges: 1 },
    space: [add('barista', [['+1 barista 07:30–08:15', [staff('barista', 1, 30, 75)]]]), add('cashier'), add('kitchen'), handoff(), grab(0.2, 0.4)],
  },
  {
    id: 'S02', title: 'Barista-bound, no new hires', provenance: 'SYNTHETIC',
    why: 'Hiring is ruled out; the best plans move people or change the menu. Hires are present as blocked distractors.',
    spec: cafe('S02', { staff: { cashier: 2, barista: 1, kitchen: 1 } }),
    constraints: { noNewHires: true },
    space: [move('cashier', 'barista'), add('barista'), grab(0.2, 0.4), handoff(), batching([15, 4], [20, 6])],
  },
  {
    id: 'S03', title: 'Kitchen-bound, sequential prep, $500 budget', provenance: 'SYNTHETIC',
    why: 'A free process change (parallel prep) competes with paid staff.',
    spec: cafe('S03', { ratePerMin: 0.55, mix: { drink: 30, food: 30, drinkFood: 40 }, food: 3.0, prepMode: 'sequential' }),
    constraints: { budgetUsd: 500 },
    space: [prep('parallel'), add('kitchen', [['+1 kitchen 07:15–08:00', [staff('kitchen', 1, 15, 60)]]]), batching([15, 4], [20, 6]), add('barista')],
  },
  {
    id: 'S04', title: 'Peaked rush, $300 budget', provenance: 'SYNTHETIC',
    why: 'Whole-rush staff is over budget; peak-only staff fits.',
    spec: cafe('S04', { curve: peaked(0.75), mix: { drink: 55, food: 15, drinkFood: 30 } }),
    constraints: { budgetUsd: 300 },
    space: [
      add('barista', [['+1 barista 07:30–08:15', [staff('barista', 1, 30, 75)]]]),
      { id: 'add-cashier-peak', label: 'Peak cashier', options: [{ label: '+1 cashier 07:30–08:15', changes: [staff('cashier', 1, 30, 75)] }] },
      { id: 'add-kitchen-peak', label: 'Peak kitchen', options: [{ label: '+1 kitchen 07:30–08:15', changes: [staff('kitchen', 1, 30, 75)] }] },
      grab(0.3),
      handoff(),
    ],
  },
  {
    id: 'S05', title: 'Quiet café: nothing should pass', provenance: 'SYNTHETIC',
    why: 'Low load; no plan should clear the 10% bar. Tests restraint (correct answer: recommend nothing).',
    spec: cafe('S05', { ratePerMin: 0.25 }),
    constraints: {},
    space: [add('barista'), add('cashier'), add('kitchen'), grab(0.3), prep('sequential')],
  },
  {
    id: 'S06', title: 'Cashier-bound', provenance: 'SYNTHETIC',
    why: 'Slow order taking; grab-and-go also loads the cashier, so it can backfire.',
    spec: cafe('S06', { ratePerMin: 0.8, order: 1.1, drink: 0.9, food: 1.8 }),
    constraints: {},
    space: [add('cashier', [['+1 cashier 07:15–08:00', [staff('cashier', 1, 15, 60)]]]), add('barista'), grab(0.2, 0.4), express()],
  },
  {
    id: 'S07', title: 'Barista slowed by handoffs, max 2 changes', provenance: 'SYNTHETIC',
    why: 'Long handoffs eat barista time; a dedicated handoff point is the targeted fix.',
    spec: cafe('S07', { ratePerMin: 0.55, handoff: 1.0 }),
    constraints: { maxChanges: 2 },
    space: [handoff(), add('barista'), express(), grab(0.3), prep('sequential')],
  },
  {
    id: 'S08', title: 'Drink-heavy, $700 budget', provenance: 'SYNTHETIC',
    why: 'Mostly drink-only orders; an express station or grab-and-go vs another barista.',
    spec: cafe('S08', { ratePerMin: 0.65, mix: { drink: 70, food: 10, drinkFood: 20 } }),
    constraints: { budgetUsd: 700 },
    space: [express(), add('barista'), grab(0.2, 0.4), add('cashier')],
  },
  {
    id: 'S09', title: 'Curio Coffee (reconstructed), $1,000 budget', provenance: 'RECONSTRUCTED',
    why: "The proposal's own ideas (parallel prep, batching, handoff zone) on a large, near-capacity café.",
    spec: curioPreset(),
    constraints: { budgetUsd: 1000 },
    space: [prep('parallel'), handoff(), add('kitchen'), add('barista'), grab(0.2, 0.4), batching([15, 8])],
  },
  {
    id: 'S10', title: 'Observed café (calibrated), max 2 changes', provenance: 'OBSERVED-CALIBRATED',
    why: 'The real café model; the live test found adding kitchen staff passes.',
    spec: observedCafePreset(),
    constraints: { maxChanges: 2 },
    space: [prep('parallel'), add('barista'), add('kitchen'), grab(0.2), handoff()],
  },
  {
    id: 'S11', title: 'Two peaks, $600 budget', provenance: 'SYNTHETIC',
    why: 'Staff only where the peaks are; several cheap windows compete.',
    spec: cafe('S11', { curve: twoPeaks(0.75), mix: { drink: 50, food: 25, drinkFood: 25 } }),
    constraints: { budgetUsd: 600 },
    space: [
      { id: 'barista-window', label: 'Extra barista', options: [
        { label: '+1 barista first peak (07:00–07:45)', changes: [staff('barista', 1, 0, 45)] },
        { label: '+1 barista second peak (08:15–09:00)', changes: [staff('barista', 1, 75, 120)] },
        { label: '+1 barista whole rush', changes: [staff('barista')] },
      ] },
      { id: 'kitchen-window', label: 'Extra kitchen', options: [
        { label: '+1 kitchen whole rush', changes: [staff('kitchen')] },
        { label: '+1 kitchen second peak', changes: [staff('kitchen', 1, 75, 120)] },
      ] },
      grab(0.3),
    ],
  },
  {
    id: 'S12', title: 'Kitchen-bound, no new hires, two baristas', provenance: 'SYNTHETIC',
    why: 'Moving a barista to the kitchen helps overall but may wreck drink-only waits (per-type rule).',
    spec: cafe('S12', { ratePerMin: 0.7, mix: { drink: 35, food: 50, drinkFood: 15 }, staff: { cashier: 1, barista: 2, kitchen: 1 }, drink: 2.2, food: 2.6 }),
    constraints: { noNewHires: true },
    space: [move('barista', 'kitchen'), prep('sequential'), batching([10, 4], [15, 6]), grab(0.3), handoff()],
  },
  {
    id: 'S13', title: 'Largest space (288 plans), $1,000, max 3 changes', provenance: 'SYNTHETIC',
    why: 'Many interacting options; tests search efficiency.',
    spec: cafe('S13', { ratePerMin: 0.7, mix: { drink: 45, food: 20, drinkFood: 35 }, food: 2.8, prepMode: 'sequential' }),
    constraints: { budgetUsd: 1000, maxChanges: 3 },
    space: [
      add('barista', [['+1 barista 07:30–08:15', [staff('barista', 1, 30, 75)]], ['+2 barista', [staff('barista', 2)]]]),
      add('kitchen', [['+1 kitchen 07:30–08:15', [staff('kitchen', 1, 30, 75)]]]),
      add('cashier'),
      handoff(),
      grab(0.2, 0.4),
      prep('parallel'),
    ],
  },
  {
    id: 'S14', title: 'Overloaded barista, $250 budget', provenance: 'SYNTHETIC',
    why: 'Waits grow through the rush; many plans help but only cheap ones fit the budget.',
    spec: cafe('S14', { ratePerMin: 0.75 }),
    constraints: { budgetUsd: 250 },
    space: [
      add('barista', [['+1 barista 07:30–08:00', [staff('barista', 1, 30, 60)]]]),
      grab(0.3, 0.5),
      handoff(),
      prep('sequential'),
    ],
  },
  {
    id: 'S15', title: 'Bakery-style food, no new hires', provenance: 'SYNTHETIC',
    why: 'Food suits batching; hires are blocked, so batching and prep mode must carry it.',
    spec: cafe('S15', { ratePerMin: 0.55, mix: { drink: 30, food: 40, drinkFood: 30 }, food: 3.0, prepMode: 'sequential' }),
    constraints: { noNewHires: true },
    space: [batching([10, 3], [15, 5], [20, 6]), prep('parallel'), add('kitchen'), add('barista')],
  },
];

for (const s of SCENARIOS) {
  const n = spaceSize(s.space);
  if (n > 300) throw new Error(`${s.id} has ${n} plans; the limit is 300`);
}
