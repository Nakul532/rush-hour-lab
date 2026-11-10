// Held-out what-if phrasings. LOCKED: written and committed after the first
// run of W01–W25 and the fixes it led to, and BEFORE the fixed reader ran on
// these. W01–W25 were seen while fixing; these ten are the fair test.
import type { WhatIfCase } from './cases';

const staff = (station: string, delta: number, fromMin?: number, toMin?: number) => ({
  kind: 'staff', station, delta, ...(fromMin !== undefined ? { fromMin, toMin } : {}),
});

export const WHATIF_HELDOUT: WhatIfCase[] = [
  { id: 'H01', question: 'what if we put 3 people on the bar', expected: [staff('barista', 2)] },
  { id: 'H02', question: 'take one person off the register', expected: [staff('cashier', -1)] },
  { id: 'H03', question: 'add 2 kichen staff from 7:15 to 8:15', expected: [staff('kitchen', 2, 15, 75)] },
  { id: 'H04', question: 'what if a third of drink orders were premade', expected: [{ kind: 'grabGo', shareOfDrinks: 0.33 }] },
  { id: 'H05', question: 'shift a cashier onto pickup', expected: [staff('cashier', -1), { kind: 'dedicatedHandoff', staff: 1 }] },
  { id: 'H06', question: 'double the baristas', expected: [staff('barista', 1)] },
  { id: 'H07', question: 'hire another cook 8 to 9', constraints: { noNewHires: true }, expected: [staff('kitchen', 1, 60, 120)], breaks: 'noNewHires' },
  { id: 'H08', question: 'what if waffles were made in batches every 20 mins', expected: [{ kind: 'foodBatching', intervalMin: 20, any: true }] },
  { id: 'H09', question: 'one extra barista and one extra cook, both 7:30-8:30', expected: [staff('barista', 1, 30, 90), staff('kitchen', 1, 30, 90)] },
  { id: 'H10', question: 'what if the coffee and food got made together', expected: [{ kind: 'prepMode', mode: 'parallel' }] },
];
