// What-if phrasing test set. LOCKED: committed before the new what-if reader
// was run on any of these phrasings. Includes the three phrasings Nakul
// reported (W01–W03); he said two of them failed in the app.
//
// One SYNTHETIC café for all cases: rush 07:00–09:00, peaked arrivals,
// 2 cashiers, 1 barista, 1 kitchen, drink first then food.
//
// A case passes when the answer is not an error, the simulated changes equal
// the expected ones (for `any`, only the kind is checked), and, for limit
// cases, the answer names the broken limit and suggests a change that passes
// the shared validator and every limit.

import type { CafeSpec } from '../../src/sim/cafe';
import { lognormal } from '../../src/sim/distributions';
import type { Constraints } from '../../src/agent/plan';
import type { ConstraintKey } from '../../src/agent/plan';

export const WHATIF_CAFE: CafeSpec = {
  name: 'What-if test café',
  arrivals: { bucketMinutes: 15, ratePerMin: [0.4, 0.6, 0.9, 1.0, 0.85, 0.7, 0.5, 0.4] },
  mix: { drink: 45, food: 20, drinkFood: 35 },
  staff: { cashier: 2, barista: 1, kitchen: 1 },
  times: { order: lognormal(0.8, 0.4), drink: lognormal(1.3, 0.4), food: lognormal(2.5, 0.4), handoff: lognormal(0.3, 0.4) },
  prepMode: 'sequential',
  handoff: 'barista',
  startsAt: '07:00',
};

/** Expected change; `any: true` checks the kind only (e.g. batching without numbers). */
export type Expected = Record<string, unknown> & { kind: string; any?: boolean };

export interface WhatIfCase {
  id: string;
  question: string;
  constraints?: Constraints;
  expected: Expected[];
  /** For limit cases: the limit the answer must name. */
  breaks?: ConstraintKey;
}

const staff = (station: string, delta: number, fromMin?: number, toMin?: number): Expected => ({
  kind: 'staff', station, delta, ...(fromMin !== undefined ? { fromMin, toMin } : {}),
});

export const WHATIF_CASES: WhatIfCase[] = [
  { id: 'W01', question: 'what if i add 4 barista', expected: [staff('barista', 4)] },
  { id: 'W02', question: '2 more cooks 8-9am', expected: [staff('kitchen', 2, 60, 120)] },
  { id: 'W03', question: 'what if we batch waffles', expected: [{ kind: 'foodBatching', any: true }] },
  { id: 'W04', question: 'add a barsita', expected: [staff('barista', 1)] },
  { id: 'W05', question: 'extra cahsier from 7:30 to 8', expected: [staff('cashier', 1, 30, 60)] },
  { id: 'W06', question: 'what if we had another person on the till', expected: [staff('cashier', 1)] },
  { id: 'W07', question: 'hire 2 baristas', constraints: { noNewHires: true }, expected: [staff('barista', 2)], breaks: 'noNewHires' },
  { id: 'W08', question: 'put someone on pickup', expected: [{ kind: 'dedicatedHandoff', staff: 1 }] },
  { id: 'W09', question: 'sell drip coffee ready to go', expected: [{ kind: 'grabGo', any: true }] },
  { id: 'W10', question: 'what if 30% of drinks were grab and go', expected: [{ kind: 'grabGo', shareOfDrinks: 0.3 }] },
  { id: 'W11', question: 'make drinks and food at the same time', expected: [{ kind: 'prepMode', mode: 'parallel' }] },
  { id: 'W12', question: 'move one cashier to the bar', expected: [staff('cashier', -1), staff('barista', 1)] },
  { id: 'W13', question: 'move a cashier to the kitchen 8-9', expected: [staff('cashier', -1, 60, 120), staff('kitchen', 1, 60, 120)] },
  { id: 'W14', question: 'add a cook for the busiest half hour', expected: [staff('kitchen', 1, 30, 60)] },
  { id: 'W15', question: 'what if we cook waffles in batches of 6 every 10 minutes', expected: [{ kind: 'foodBatching', intervalMin: 10, batchSize: 6 }] },
  { id: 'W16', question: 'one more barista and one more cook', expected: [staff('barista', 1), staff('kitchen', 1)] },
  { id: 'W17', question: 'fewer cashiers', expected: [staff('cashier', -1)] },
  { id: 'W18', question: '2 extra baristas from 8am to 9am', expected: [staff('barista', 2, 60, 120)] },
  { id: 'W19', question: 'what if i add a barista', constraints: { noNewHires: true }, expected: [staff('barista', 1)], breaks: 'noNewHires' },
  { id: 'W20', question: 'add three cooks', constraints: { budgetUsd: 500 }, expected: [staff('kitchen', 3)], breaks: 'budget' },
  { id: 'W21', question: 'what if we had an express lane for drinks', expected: [{ kind: 'expressDrinks', staff: 1 }] },
  { id: 'W22', question: 'add a barista at 7:45 till 8:15', expected: [staff('barista', 1, 45, 75)] },
  { id: 'W23', question: 'what about a second barista during the rush', expected: [staff('barista', 1)] },
  { id: 'W24', question: 'what if we batch brew coffee', expected: [{ kind: 'grabGo', any: true }] },
  { id: 'W25', question: 'Wat if we hav 2 cooks n 2 baristas', expected: [staff('kitchen', 1), staff('barista', 1)] },
];
