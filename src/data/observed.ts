// OBSERVED: Nakul's 18 timed orders (Bay Area café, one moderate-traffic session).
// Source: DATA.md §1. "wait" = minutes from placing the order to receiving it.
// Logged clock times are unreliable, so only wait, type and queue count are kept.
// No customer personal data is recorded.


export const OBSERVED_PROVENANCE = "OBSERVED: Nakul's 18 timed orders, one moderate-traffic session at a Bay Area café";

/** The order types recorded in the log. Grab-and-go items were logged as "drink". */
export type ObservedType = 'drink' | 'food' | 'drinkFood';
export const OBSERVED_TYPES: readonly ObservedType[] = ['drink', 'food', 'drinkFood'];

export interface ObservedOrder {
  id: number;
  type: ObservedType;
  waitMin: number;
  /** People in the queue when the order was timed; null where the log is unusable. */
  queueCount: number | null;
}

export const OBSERVED_ORDERS: readonly ObservedOrder[] = [
  { id: 1, type: 'drink', waitMin: 4, queueCount: 3 },
  { id: 2, type: 'drink', waitMin: 3, queueCount: 2 },
  { id: 3, type: 'drinkFood', waitMin: 7, queueCount: 1 },
  { id: 4, type: 'drink', waitMin: 8, queueCount: 4 },
  { id: 5, type: 'drink', waitMin: 9, queueCount: 3 },
  { id: 6, type: 'drink', waitMin: 1, queueCount: 3 },
  { id: 7, type: 'food', waitMin: 3, queueCount: 2 },
  { id: 8, type: 'food', waitMin: 2, queueCount: 3 },
  { id: 9, type: 'food', waitMin: 13, queueCount: 3 },
  { id: 10, type: 'food', waitMin: 14, queueCount: 3 },
  { id: 11, type: 'drink', waitMin: 5, queueCount: null }, // logged "31": likely a typo for 3, treated as unknown
  { id: 12, type: 'drink', waitMin: 16, queueCount: 3 },
  { id: 13, type: 'drinkFood', waitMin: 17, queueCount: 3 },
  { id: 14, type: 'drinkFood', waitMin: 18, queueCount: 3 },
  { id: 15, type: 'drinkFood', waitMin: 19, queueCount: 3 },
  { id: 16, type: 'drinkFood', waitMin: 8, queueCount: 3 },
  { id: 17, type: 'drink', waitMin: 1, queueCount: 3 },
  { id: 18, type: 'drink', waitMin: 2, queueCount: 3 },
];
