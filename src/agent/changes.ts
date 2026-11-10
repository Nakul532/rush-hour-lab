// The menu of changes the agent may propose. The LLM never edits a café
// config directly: it picks changes from this menu, and code checks and
// applies them. That keeps every config valid and makes constraints
// (headcount, number of changes, budget) easy to check.

import { windowMinutes } from '../sim/arrivals';
import { toWindows, type CafeSpec, type Staffing } from '../sim/cafe';
import { lognormal } from '../sim/distributions';
import type { StaffWindow } from '../sim/types';

export type StationName = 'cashier' | 'barista' | 'kitchen' | 'handoff' | 'express';
export const STATION_NAMES: readonly StationName[] = ['cashier', 'barista', 'kitchen', 'handoff', 'express'];

export type Change =
  /** Add (or remove, if negative) staff at a station, optionally only between two minutes of the rush. */
  | { kind: 'staff'; station: StationName; delta: number; fromMin?: number; toMin?: number }
  /** Make drink + food orders in parallel or one after the other. */
  | { kind: 'prepMode'; mode: 'parallel' | 'sequential' }
  /** Cook food to stock in batches. cookMin defaults to the current median food time. */
  | { kind: 'foodBatching'; intervalMin: number; batchSize: number; cookMin?: number }
  /** A dedicated handoff point with its own staff (instead of the barista handing over). */
  | { kind: 'dedicatedHandoff'; staff: number }
  /** A second drink station for drink-only orders. */
  | { kind: 'expressDrinks'; staff: number }
  /** Sell a share of drink-only orders as grab-and-go ready items (e.g. batch-brewed drip coffee). */
  | { kind: 'grabGo'; shareOfDrinks: number };

export const CHANGE_KINDS = ['staff', 'prepMode', 'foodBatching', 'dedicatedHandoff', 'expressDrinks', 'grabGo'] as const;

export class ChangeError extends Error {}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Check one change proposed by the LLM against the menu and the café.
 * Returns the cleaned change, or throws ChangeError with a message the LLM can act on.
 */
export function parseChange(raw: unknown, spec: CafeSpec): Change {
  if (typeof raw !== 'object' || raw === null) throw new ChangeError('Each change must be an object');
  const c = raw as Record<string, unknown>;
  const rush = windowMinutes(spec.arrivals);
  switch (c.kind) {
    case 'staff': {
      if (c.station === undefined || c.delta === undefined)
        throw new ChangeError('A staff change needs "station" (cashier, barista, kitchen, handoff or express) and "delta" (e.g. 1), e.g. {"kind":"staff","station":"kitchen","delta":1}');
      if (!STATION_NAMES.includes(c.station as StationName))
        throw new ChangeError(`Unknown station "${String(c.station)}". Stations: ${STATION_NAMES.join(', ')}`);
      const station = c.station as StationName;
      if (station === 'handoff' && spec.handoff !== 'dedicated')
        throw new ChangeError('This café has no dedicated handoff station; use a dedicatedHandoff change first');
      if (station === 'express' && spec.drinkOnlyStation !== 'express')
        throw new ChangeError('This café has no express drink station; use an expressDrinks change first');
      if (!isInt(c.delta) || c.delta === 0 || Math.abs(c.delta) > 3) throw new ChangeError('delta must be a whole number from -3 to 3, not 0');
      const fromMin = c.fromMin === undefined ? undefined : c.fromMin;
      const toMin = c.toMin === undefined ? undefined : c.toMin;
      if (fromMin !== undefined && (!isNum(fromMin) || fromMin < 0 || fromMin >= rush)) throw new ChangeError(`fromMin must be between 0 and ${rush}`);
      if (toMin !== undefined && (!isNum(toMin) || toMin <= (fromMin ?? 0) || toMin > rush)) throw new ChangeError(`toMin must be after fromMin and at most ${rush}`);
      return { kind: 'staff', station, delta: c.delta, ...(fromMin !== undefined ? { fromMin } : {}), ...(toMin !== undefined ? { toMin } : {}) };
    }
    case 'prepMode':
      if (c.mode !== 'parallel' && c.mode !== 'sequential') throw new ChangeError('mode must be "parallel" or "sequential"');
      return { kind: 'prepMode', mode: c.mode };
    case 'foodBatching':
      if (!isNum(c.intervalMin) || c.intervalMin < 5 || c.intervalMin > 60) throw new ChangeError('intervalMin must be 5–60');
      if (!isInt(c.batchSize) || c.batchSize < 1 || c.batchSize > 50) throw new ChangeError('batchSize must be a whole number 1–50');
      if (c.cookMin !== undefined && (!isNum(c.cookMin) || c.cookMin <= 0 || c.cookMin > 60)) throw new ChangeError('cookMin must be 0–60');
      return { kind: 'foodBatching', intervalMin: c.intervalMin, batchSize: c.batchSize, ...(c.cookMin !== undefined ? { cookMin: c.cookMin as number } : {}) };
    case 'dedicatedHandoff':
    case 'expressDrinks':
      if (!isInt(c.staff) || c.staff < 1 || c.staff > 3) throw new ChangeError('staff must be a whole number 1–3');
      return { kind: c.kind, staff: c.staff };
    case 'grabGo':
      if (!isNum(c.shareOfDrinks) || c.shareOfDrinks <= 0 || c.shareOfDrinks > 0.8) throw new ChangeError('shareOfDrinks must be above 0 and at most 0.8');
      return { kind: 'grabGo', shareOfDrinks: c.shareOfDrinks };
    default:
      throw new ChangeError(`Unknown change kind "${String(c.kind)}". Kinds: ${CHANGE_KINDS.join(', ')}`);
  }
}

/** Parse a list of changes, applying each in order so later ones can build on earlier ones. */
export function parseChanges(raw: unknown, spec: CafeSpec): Change[] {
  if (!Array.isArray(raw)) throw new ChangeError('changes must be a list');
  const out: Change[] = [];
  let current = spec;
  for (const r of raw) {
    const c = parseChange(r, current);
    out.push(c);
    current = applyChange(current, c);
  }
  const problems = validatePlan(spec, out);
  if (problems.length > 0) throw new ChangeError(problems.join('; '));
  return out;
}

/** Stations that orders go to in this café (and so must be staffed). */
export function stationsInUse(spec: CafeSpec): Array<keyof CafeSpec['staff']> {
  const used: Array<keyof CafeSpec['staff']> = ['cashier', 'barista'];
  const anyFood = (spec.mix.food ?? 0) > 0 || (spec.mix.drinkFood ?? 0) > 0;
  if (anyFood && !spec.foodBatching) used.push('kitchen');
  if (spec.handoff === 'dedicated') used.push('handoff');
  if (spec.drinkOnlyStation === 'express') used.push('express');
  return used;
}

function clockLabel(startsAt: string | undefined, m: number): string {
  if (!startsAt) return `minute ${m}`;
  const [h, mm] = startsAt.split(':').map(Number);
  const t = h * 60 + mm + m;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * THE plan validator. Every path that evaluates a plan goes through it:
 * the LLM agent and what-if (via parseChanges), and greedy, brute force, the
 * hybrid, the rule-based baseline and the evaluation (via runExperiment).
 *
 * A plan is invalid if it cannot be applied, or if any station that orders
 * go to has no staff at any point during the rush. (This bug appeared twice:
 * first an empty kitchen, then an empty register.)
 * Returns the problems in plain English; an empty list means the plan is valid.
 */
export function validatePlan(base: CafeSpec, changes: Change[]): string[] {
  let after: CafeSpec;
  try {
    after = applyChanges(base, changes);
  } catch (err) {
    if (err instanceof ChangeError) return [err.message];
    throw err;
  }
  const rush = windowMinutes(after.arrivals);
  const problems: string[] = [];
  for (const k of stationsInUse(after)) {
    const s = after.staff[k];
    if (s === undefined) {
      problems.push(`The plan sends orders to the ${k} station, which has no staff`);
      continue;
    }
    const w = toWindows(s);
    w.forEach((win, i) => {
      if (win.servers > 0 || win.fromMin >= rush) return;
      const to = Math.min(w[i + 1]?.fromMin ?? rush, rush);
      const whole = win.fromMin === 0 && to === rush;
      problems.push(
        `The plan leaves ${k} with no staff ${whole ? 'for the whole rush' : `from ${clockLabel(after.startsAt, win.fromMin)} to ${clockLabel(after.startsAt, to)}`}, so orders there would wait or never be served`,
      );
    });
  }
  return problems;
}

function serversAt(windows: StaffWindow[], t: number): number {
  let s = windows[0].servers;
  for (const w of windows) if (w.fromMin <= t) s = w.servers;
  return s;
}

/** Add `delta` staff between fromMin and toMin to a staffing schedule. */
export function addStaff(staffing: Staffing, delta: number, fromMin = 0, toMin = Infinity): StaffWindow[] {
  const w = toWindows(staffing);
  const cuts = new Set<number>([0, ...w.map((x) => x.fromMin), fromMin]);
  if (Number.isFinite(toMin)) cuts.add(toMin);
  const out: StaffWindow[] = [];
  for (const t of [...cuts].sort((a, b) => a - b)) {
    const servers = serversAt(w, t) + (t >= fromMin && t < toMin ? delta : 0);
    if (servers < 0) throw new ChangeError('A station cannot have fewer than 0 staff');
    if (out.length > 0 && out[out.length - 1].servers === servers) continue;
    out.push({ fromMin: t, servers });
  }
  return out;
}

export function applyChange(spec: CafeSpec, change: Change): CafeSpec {
  const s: CafeSpec = structuredClone(spec);
  switch (change.kind) {
    case 'staff': {
      const cur = s.staff[change.station];
      if (cur === undefined) throw new ChangeError(`Station "${change.station}" does not exist in this café`);
      s.staff[change.station] = addStaff(cur, change.delta, change.fromMin, change.toMin);
      return s;
    }
    case 'prepMode':
      s.prepMode = change.mode;
      return s;
    case 'foodBatching': {
      const food = s.times.food;
      const cookMin = change.cookMin ?? (food.kind === 'lognormal' ? food.median : food.kind === 'exponential' ? food.mean : food.value);
      s.foodBatching = { intervalMin: change.intervalMin, batchSize: change.batchSize, cookMin };
      return s;
    }
    case 'dedicatedHandoff':
      s.handoff = 'dedicated';
      s.staff.handoff = change.staff;
      return s;
    case 'expressDrinks':
      s.drinkOnlyStation = 'express';
      s.staff.express = change.staff;
      return s;
    case 'grabGo': {
      const drink = s.mix.drink ?? 0;
      const moved = drink * change.shareOfDrinks;
      s.mix = { ...s.mix, drink: drink - moved, grabGo: (s.mix.grabGo ?? 0) + moved };
      if (!s.times.grab) s.times.grab = lognormal(0.3, 0.5);
      return s;
    }
  }
}

/** Merge whole-rush staff changes per station and drop ones that cancel out. */
export function simplifyChanges(changes: Change[]): Change[] {
  const staff = new Map<StationName, number>();
  const rest: Change[] = [];
  for (const c of changes) {
    if (c.kind === 'staff' && c.fromMin === undefined && c.toMin === undefined) staff.set(c.station, (staff.get(c.station) ?? 0) + c.delta);
    else rest.push(c);
  }
  const merged: Change[] = [...staff.entries()].filter(([, d]) => d !== 0).map(([station, delta]) => ({ kind: 'staff', station, delta }));
  // Removals first so a station never briefly needs a negative head count.
  merged.sort((a, b) => (a.kind === 'staff' && b.kind === 'staff' ? a.delta - b.delta : 0));
  return [...merged, ...rest];
}

export function applyChanges(spec: CafeSpec, changes: Change[]): CafeSpec {
  return changes.reduce(applyChange, spec);
}

/** Plain-English description of a change, for the agent steps panel. */
export function describeChange(c: Change, startsAt?: string): string {
  const when = (from?: number, to?: number) => {
    if (from === undefined && to === undefined) return 'for the whole rush';
    const clock = (m: number) => {
      if (!startsAt) return `minute ${m}`;
      const [h, mm] = startsAt.split(':').map(Number);
      const t = h * 60 + mm + m;
      return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    };
    return `from ${clock(from ?? 0)}${to !== undefined ? ` to ${clock(to)}` : ''}`;
  };
  switch (c.kind) {
    case 'staff':
      return `${c.delta > 0 ? 'Add' : 'Remove'} ${Math.abs(c.delta)} ${c.station} staff ${when(c.fromMin, c.toMin)}`;
    case 'prepMode':
      return c.mode === 'parallel' ? 'Make drinks and food at the same time' : 'Make the drink first, then the food';
    case 'foodBatching':
      return `Cook food in batches of ${c.batchSize} every ${c.intervalMin} min`;
    case 'dedicatedHandoff':
      return `Add a dedicated handoff point with ${c.staff} staff`;
    case 'expressDrinks':
      return `Add an express drink station for drink-only orders with ${c.staff} staff`;
    case 'grabGo':
      return `Sell ${Math.round(c.shareOfDrinks * 100)}% of drink-only orders as grab-and-go items`;
  }
}
