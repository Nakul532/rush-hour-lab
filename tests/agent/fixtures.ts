// SYNTHETIC test cafés (not real data), used only to exercise the agent.
import { constantCurve } from '../../src/sim/arrivals';
import type { CafeSpec } from '../../src/sim/cafe';
import { lognormal } from '../../src/sim/distributions';
import type { SimSettings } from '../../src/agent/evaluate';

export const SIM: SimSettings = { reps: 150, seed: 1 };

/** Busy barista, kitchen close behind. Adding a barista clearly helps. */
export function syntheticCafe(overrides: Partial<CafeSpec> = {}): CafeSpec {
  return {
    name: 'Synthetic test café',
    arrivals: constantCurve(0.6, 90),
    mix: { drink: 50, food: 20, drinkFood: 30 },
    staff: { cashier: 1, barista: 1, kitchen: 1 },
    times: { order: lognormal(0.8, 0.4), drink: lognormal(1.3, 0.4), food: lognormal(2.5, 0.4), handoff: lognormal(0.3, 0.4) },
    prepMode: 'parallel',
    handoff: 'barista',
    startsAt: '07:30',
    ...overrides,
  };
}

/** Food-heavy café where moving a barista to the kitchen helps overall but wrecks drink-only waits. */
export function foodHeavyCafe(): CafeSpec {
  return syntheticCafe({
    arrivals: constantCurve(0.7, 90),
    mix: { drink: 35, food: 50, drinkFood: 15 },
    staff: { cashier: 1, barista: 2, kitchen: 1 },
    times: { order: lognormal(0.8, 0.4), drink: lognormal(2.2, 0.4), food: lognormal(2.6, 0.4), handoff: lognormal(0.3, 0.4) },
    startsAt: undefined,
  });
}

/** Last tool result the mock LLM was sent, parsed. */
export function lastToolResult(messages: Array<{ role: string; content?: unknown }>): Record<string, unknown> {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'tool') return JSON.parse(messages[i].content as string);
  return {};
}
