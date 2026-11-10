// Costs and constraints for a set of changes. All checks are plain code.

import { windowMinutes } from '../sim/arrivals';
import { toWindows, type CafeSpec } from '../sim/cafe';
import { applyChanges, type Change } from './changes';

/**
 * Cost of each kind of change, in dollars. The user enters these; the
 * defaults are ASSUMPTIONS, not data, and are labelled as such everywhere.
 * Staff costs are for the first month: hourly rate × added hours per rush × rush days.
 */
export interface CostTable {
  staffHourly: number;
  rushDaysPerMonth: number;
  prepMode: number;
  foodBatching: number;
  dedicatedHandoffSetup: number;
  expressDrinksSetup: number;
  grabGoSetup: number;
}

export const DEFAULT_COSTS: CostTable = {
  staffHourly: 20,
  rushDaysPerMonth: 22,
  prepMode: 0,
  foodBatching: 50,
  dedicatedHandoffSetup: 150,
  expressDrinksSetup: 400,
  grabGoSetup: 200,
};
export const DEFAULT_COSTS_PROVENANCE = 'ASSUMPTION: default costs, not data. Replace them with your own.';

export interface Constraints {
  /** Total staff on shift may never exceed today's at any minute (people can move between stations). */
  noNewHires?: boolean;
  /** Most changes allowed in one plan. */
  maxChanges?: number;
  /** Most the plan may cost (first month), in dollars. */
  budgetUsd?: number;
}

type StaffKey = keyof CafeSpec['staff'];
const STAFF_KEYS: StaffKey[] = ['cashier', 'barista', 'kitchen', 'handoff', 'express'];

/** Total staff on shift at minute t (every station that exists). */
export function totalStaffAt(spec: CafeSpec, t: number): number {
  let total = 0;
  for (const k of STAFF_KEYS) {
    const s = spec.staff[k];
    if (s === undefined) continue;
    if (k === 'handoff' && spec.handoff !== 'dedicated') continue;
    if (k === 'express' && spec.drinkOnlyStation !== 'express') continue;
    let servers = toWindows(s)[0].servers;
    for (const w of toWindows(s)) if (w.fromMin <= t) servers = w.servers;
    total += servers;
  }
  return total;
}

function staffBoundaries(spec: CafeSpec): number[] {
  const set = new Set<number>([0]);
  for (const k of STAFF_KEYS) {
    const s = spec.staff[k];
    if (s !== undefined) for (const w of toWindows(s)) set.add(w.fromMin);
  }
  return [...set].sort((a, b) => a - b);
}

/** Extra staff-hours per rush the plan adds (negative if it removes staff). */
export function addedStaffHours(base: CafeSpec, after: CafeSpec): number {
  const rush = windowMinutes(base.arrivals);
  const cuts = [...new Set([...staffBoundaries(base), ...staffBoundaries(after), rush])].filter((t) => t <= rush).sort((a, b) => a - b);
  let minutes = 0;
  for (let i = 0; i < cuts.length - 1; i++) minutes += (totalStaffAt(after, cuts[i]) - totalStaffAt(base, cuts[i])) * (cuts[i + 1] - cuts[i]);
  return minutes / 60;
}

export function planCost(base: CafeSpec, changes: Change[], costs: CostTable): number {
  let setup = 0;
  for (const c of changes) {
    if (c.kind === 'prepMode') setup += costs.prepMode;
    if (c.kind === 'foodBatching') setup += costs.foodBatching;
    if (c.kind === 'dedicatedHandoff') setup += costs.dedicatedHandoffSetup;
    if (c.kind === 'expressDrinks') setup += costs.expressDrinksSetup;
    if (c.kind === 'grabGo') setup += costs.grabGoSetup;
  }
  const hours = Math.max(0, addedStaffHours(base, applyChanges(base, changes)));
  return setup + hours * costs.staffHourly * costs.rushDaysPerMonth;
}

export type ConstraintKey = 'maxChanges' | 'noNewHires' | 'budget';

export interface ConstraintBreak {
  key: ConstraintKey;
  /** Plain English, e.g. "Needs 2 more people on shift than you have today (your limit: no new hires)". */
  message: string;
}

/** Every constraint the plan breaks, with which limit it is. Empty means the plan is allowed. */
export function constraintBreaks(base: CafeSpec, changes: Change[], constraints: Constraints, costs: CostTable): ConstraintBreak[] {
  const out: ConstraintBreak[] = [];
  if (constraints.maxChanges !== undefined && changes.length > constraints.maxChanges)
    out.push({ key: 'maxChanges', message: `Uses ${changes.length} changes; the limit is ${constraints.maxChanges}` });
  if (constraints.noNewHires) {
    const after = applyChanges(base, changes);
    const cuts = [...new Set([...staffBoundaries(base), ...staffBoundaries(after)])];
    const extra = Math.max(...cuts.map((t) => totalStaffAt(after, t) - totalStaffAt(base, t)));
    if (extra > 0)
      out.push({ key: 'noNewHires', message: `Needs ${extra} more ${extra === 1 ? 'person' : 'people'} on shift than you have today (your limit: no new hires)` });
  }
  if (constraints.budgetUsd !== undefined) {
    const cost = planCost(base, changes, costs);
    if (cost > constraints.budgetUsd)
      out.push({ key: 'budget', message: `Costs about $${Math.round(cost).toLocaleString('en-US')} in the first month; the budget is $${constraints.budgetUsd.toLocaleString('en-US')}` });
  }
  return out;
}

/** Every constraint the plan breaks, in plain English. Empty means the plan is allowed. */
export function constraintViolations(base: CafeSpec, changes: Change[], constraints: Constraints, costs: CostTable): string[] {
  return constraintBreaks(base, changes, constraints, costs).map((b) => b.message);
}
