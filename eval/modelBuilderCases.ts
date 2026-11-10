// Model-builder evaluation: 10 hand-written café descriptions with the
// correct draft for each. LOCKED before running. Only fields the
// description states are expected; anything else the model fills in counts
// as invented.

import type { CafeDraft } from '../src/agent/modelBuilder';

export interface BuilderCase {
  id: string;
  description: string;
  expected: CafeDraft;
}

export const BUILDER_CASES: BuilderCase[] = [
  {
    id: 'B01',
    description: 'Small café, we open at 7. The morning rush lasts two hours and we get about 40 orders an hour. One cashier, one barista, one person in the kitchen. Drinks take about 2 minutes, sandwiches about 5.',
    expected: { rushMinutes: 120, startsAt: '07:00', ordersPerHour: 40, staff: { cashier: 1, barista: 1, kitchen: 1 }, minutes: { drink: 2, food: 5 } },
  },
  {
    id: 'B02',
    description: 'Two baristas and one cashier, no kitchen staff, but we do sell pastries. Around 60 customers an hour between 8 and 9:30.',
    expected: { rushMinutes: 90, startsAt: '08:00', ordersPerHour: 60, staff: { cashier: 1, barista: 2, kitchen: 0 } },
  },
  {
    id: 'B03',
    description: "About half our orders are just a drink, a fifth are food only, and the rest are a drink with food. We make the drink first and then start the food. One person each on register, bar and grill.",
    expected: { mixPercent: { drink: 50, food: 20, drinkFood: 30 }, prepMode: 'sequential', staff: { cashier: 1, barista: 1, kitchen: 1 } },
  },
  {
    id: 'B04',
    description: 'Busy weekday mornings from 6:30, roughly 90 minutes, maybe 75 orders an hour. Taking an order takes about a minute. Three baristas, two cashiers, two cooks.',
    expected: { startsAt: '06:30', rushMinutes: 90, ordersPerHour: 75, minutes: { order: 1 }, staff: { cashier: 2, barista: 3, kitchen: 2 } },
  },
  {
    id: 'B05',
    description: 'We have a dedicated person at the pickup counter who calls out names and hands over orders. One barista, one cashier, one in the kitchen. Food takes about 7 minutes.',
    expected: { handoff: 'dedicated', staff: { cashier: 1, barista: 1, kitchen: 1, handoff: 1 }, minutes: { food: 7 } },
  },
  {
    id: 'B06',
    description: 'Waffle shop. We cook waffles in batches of 6 every 10 minutes during the 2-hour rush, about 50 orders an hour.',
    expected: { foodBatching: { intervalMin: 10, batchSize: 6 }, rushMinutes: 120, ordersPerHour: 50 },
  },
  {
    id: 'B07',
    description: 'Tiny kiosk: one person does everything at the register, plus one barista. Drinks only, about 30 an hour. A drink takes 90 seconds.',
    expected: { staff: { cashier: 1, barista: 1, kitchen: 0 }, mixPercent: { drink: 100, food: 0, drinkFood: 0 }, ordersPerHour: 30, minutes: { drink: 1.5 } },
  },
  {
    id: 'B08',
    description: 'Lunch rush 11:30 to 1:30. Drinks and food are made at the same time by different people. 2 baristas, 2 kitchen staff, 1 cashier. Around 55 orders per hour; 40% drink only, 30% food only, 30% both.',
    expected: {
      startsAt: '11:30', rushMinutes: 120, prepMode: 'parallel', staff: { cashier: 1, barista: 2, kitchen: 2 }, ordersPerHour: 55,
      mixPercent: { drink: 40, food: 30, drinkFood: 30 },
    },
  },
  {
    id: 'B09',
    description: 'The barista also hands the orders out. Handing over takes about 30 seconds. Espresso drinks about 3 minutes each. One barista, one cashier.',
    expected: { handoff: 'barista', minutes: { handoff: 0.5, drink: 3 }, staff: { cashier: 1, barista: 1 } },
  },
  {
    id: 'B10',
    description: 'Our rush is 45 minutes at 8:15 with about 100 orders an hour. Four baristas, two at the till, one in the kitchen. Food is about 4 minutes, drinks about a minute and a half, handoff 20 seconds.',
    expected: {
      rushMinutes: 45, startsAt: '08:15', ordersPerHour: 100, staff: { cashier: 2, barista: 4, kitchen: 1 },
      minutes: { food: 4, drink: 1.5, handoff: 20 / 60 },
    },
  },
];

/**
 * Held-out cases, written and committed after the first builder run and
 * BEFORE the prompt fix for stated zeros was run on anything. The fix was
 * written looking at B01–B10 failures, so B01–B10 are no longer a fair test
 * of it; these five are.
 */
export const BUILDER_HELDOUT: BuilderCase[] = [
  {
    id: 'H01',
    description: 'Coffee cart at the station, 6am to 8am. Just me making drinks and my partner taking payment. No food at all. Maybe 35 orders an hour.',
    expected: { startsAt: '06:00', rushMinutes: 120, staff: { cashier: 1, barista: 1, kitchen: 0 }, mixPercent: { drink: 100, food: 0, drinkFood: 0 }, ordersPerHour: 35 },
  },
  {
    id: 'H02',
    description: 'Bagel shop. 60% of orders are food only, a quarter come with a coffee, the rest are coffee only. We toast first and pour the coffee after. Two on the toaster, one barista, one cashier.',
    expected: { mixPercent: { food: 60, drinkFood: 25, drink: 15 }, prepMode: 'sequential', staff: { kitchen: 2, barista: 1, cashier: 1 } },
  },
  {
    id: 'H03',
    description: 'We have no cashier; customers order from the barista, who also hands everything out. One barista, one cook. Rush is 9 to 10.',
    expected: { staff: { cashier: 0, barista: 1, kitchen: 1 }, handoff: 'barista', startsAt: '09:00', rushMinutes: 60 },
  },
  {
    id: 'H04',
    description: 'Around 120 orders over a 90-minute rush starting 7:45. Two baristas and two cashiers. Drinks take 2.5 minutes. Pastries are grab-from-the-case, no kitchen staff.',
    expected: { ordersPerHour: 80, rushMinutes: 90, startsAt: '07:45', staff: { barista: 2, cashier: 2, kitchen: 0 }, minutes: { drink: 2.5 } },
  },
  {
    id: 'H05',
    description: 'Brunch café, 10:30 to 12:30. Kitchen and bar work at the same time on combined orders. 3 cooks, 2 baristas, 1 cashier, and someone at the pass handing out orders. Food takes 8 minutes.',
    expected: { startsAt: '10:30', rushMinutes: 120, prepMode: 'parallel', staff: { kitchen: 3, barista: 2, cashier: 1, handoff: 1 }, handoff: 'dedicated', minutes: { food: 8 } },
  },
];
