// Curio Coffee: SECONDARY preset, reconstructed from a 2025 class Lean
// proposal (DATA.md §4). The proposal's recommendations were not
// implemented, and its figures do not fit together (see
// calibration/CURIO.md). The primary example is the observed café.
//
// How it is reconstructed:
// - Volume: ~300 orders over the 2-hour peak (7:30–9:30), flat. (Proposal figure.)
// - The value-stream step times (order 1, cashier entry 1–2, barista 4–5,
//   kitchen 6–7, packaging/handoff 1–2 min) are read as ELAPSED time per step,
//   waiting included. Hands-on task times are those times × one scale factor,
//   fitted so the simulated median wait lands in the 8–12 min staff reported.
// - Staffing, order mix and spread are ASSUMPTIONS.

import { constantCurve } from '../sim/arrivals';
import type { CafeSpec } from '../sim/cafe';
import { lognormal } from '../sim/distributions';

export const CURIO_LABEL = 'Reconstructed from a 2025 class proposal; original figures were inconsistent';
export const CURIO_NOT_IMPLEMENTED = 'Based on a 2025 Lean proposal; recommendations were not implemented';

/** Value-stream step times from the proposal, midpoints, minutes (elapsed, waiting included). */
export const CURIO_VALUE_STREAM = { order: 1 + 1.5, drink: 4.5, food: 6.5, handoff: 1.5 } as const;

/** Reported by staff (proposal): typical wait 8–12 min. The calibration target. */
export const CURIO_REPORTED_WAIT = { low: 8, high: 12 } as const;

export const CURIO_ASSUMPTIONS = [
  'Volume: 300 orders in 2 hours, at a flat rate (proposal figure; see the inconsistency note)',
  'ASSUMPTION: 2 cashiers, 4 baristas, 3 kitchen staff (waffle irons); the baristas hand over orders',
  'ASSUMPTION: order mix 45% drink only, 20% waffle only, 35% drink + waffle (from sales shares: espresso ~40%, waffles ~35%)',
  'ASSUMPTION: drink first, then waffle (the proposal lists the steps in sequence and suggests parallel prep as an improvement)',
  'ASSUMPTION: task-time spread lognormal sigma 0.4',
  'Fitted: one scale factor turning elapsed step times into hands-on task times',
];

/** Fitted by `npm run calibrate:curio` (see calibration/CURIO.md). */
export const CURIO_SCALE = 0.37;

export function curioSpec(scale: number): CafeSpec {
  const t = (minutes: number) => lognormal(minutes * scale, 0.4);
  return {
    name: 'Curio Coffee (reconstructed)',
    arrivals: constantCurve(300 / 120, 120),
    mix: { drink: 45, food: 20, drinkFood: 35 },
    staff: { cashier: 2, barista: 4, kitchen: 3 },
    times: { order: t(CURIO_VALUE_STREAM.order), drink: t(CURIO_VALUE_STREAM.drink), food: t(CURIO_VALUE_STREAM.food), handoff: t(CURIO_VALUE_STREAM.handoff) },
    prepMode: 'sequential',
    handoff: 'barista',
    measureFromMin: 15,
    startsAt: '07:30',
  };
}

export function curioPreset(): CafeSpec {
  return curioSpec(CURIO_SCALE);
}
