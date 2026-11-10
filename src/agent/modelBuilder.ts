// Model builder: plain-English café description → simulation config.
// The LLM fills a draft with only what the user said. Code validates it,
// fills gaps with labelled defaults, and lists every assumption so the user
// can see and confirm the config before anything runs.

import { constantCurve } from '../sim/arrivals';
import type { CafeSpec } from '../sim/cafe';
import { lognormal } from '../sim/distributions';
import type { OrderType } from '../sim/types';
import { OBSERVED_CAFE_FIT } from '../presets/observedCafe';
import { LlmLimitError, type ChatMessage, type LlmClient } from './llm';
import { BUILD_MODEL_TOOL } from './prompts';

export interface CafeDraft {
  name?: string;
  rushMinutes?: number;
  startsAt?: string;
  ordersPerHour?: number;
  mixPercent?: Partial<Record<OrderType, number>>;
  staff?: { cashier?: number; barista?: number; kitchen?: number; handoff?: number };
  minutes?: { order?: number; drink?: number; food?: number; handoff?: number };
  prepMode?: 'parallel' | 'sequential';
  handoff?: 'barista' | 'dedicated';
  foodBatching?: { intervalMin: number; batchSize: number };
}

export interface BuiltModel {
  spec: CafeSpec;
  draft: CafeDraft;
  /** Every value the description did not give, with the default used. Shown to the user. */
  assumptions: string[];
  /** Values that were given but unusable (and replaced by a default). */
  problems: string[];
  /** The user must confirm before any simulation runs. */
  confirmed: false;
}

export const SPREAD_DEFAULT = 0.4;

const DEFAULTS = {
  rushMinutes: { value: 120, why: 'ASSUMPTION' },
  ordersPerHour: { value: 30, why: 'ASSUMPTION' },
  mixPercent: { value: { drink: 50, food: 22, drinkFood: 28, grabGo: 0 }, why: 'OBSERVED order mix of 18 orders at one Bay Area café' },
  staff: { value: 1, why: 'ASSUMPTION' },
  minutes: {
    order: { value: 1.0, why: 'PUBLISHED BENCHMARK (approx.)' },
    drink: { value: OBSERVED_CAFE_FIT.drinkMedian, why: 'calibrated on 18 observed orders' },
    food: { value: OBSERVED_CAFE_FIT.foodMedian, why: 'calibrated on 18 observed orders' },
    handoff: { value: 0.5, why: 'ASSUMPTION' },
  },
} as const;

const inRange = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;

export function draftToSpec(draft: CafeDraft): BuiltModel {
  const assumptions: string[] = [];
  const problems: string[] = [];
  const pick = (label: string, given: unknown, lo: number, hi: number, fallback: number, why: string): number => {
    if (given === undefined || given === null) {
      assumptions.push(`${label}: ${fallback} (${why})`);
      return fallback;
    }
    if (!inRange(given, lo, hi)) {
      problems.push(`${label}: "${String(given)}" is outside ${lo}–${hi}; used ${fallback} (${why})`);
      return fallback;
    }
    return given;
  };

  const rush = pick('Rush length (min)', draft.rushMinutes, 15, 360, DEFAULTS.rushMinutes.value, DEFAULTS.rushMinutes.why);
  const perHour = pick('Orders per hour', draft.ordersPerHour, 1, 600, DEFAULTS.ordersPerHour.value, DEFAULTS.ordersPerHour.why);

  let mix: Partial<Record<OrderType, number>>;
  const given = draft.mixPercent;
  const validMix = given && Object.values(given).every((v) => inRange(v, 0, 100)) && Object.values(given).reduce((a, b) => a + (b ?? 0), 0) > 0;
  if (validMix) mix = { drink: given!.drink ?? 0, food: given!.food ?? 0, drinkFood: given!.drinkFood ?? 0, grabGo: given!.grabGo ?? 0 };
  else {
    mix = { ...DEFAULTS.mixPercent.value };
    (given ? problems : assumptions).push(`Order mix: drink 50%, food 22%, drink + food 28% (${DEFAULTS.mixPercent.why})`);
  }

  const staffCount = (k: 'cashier' | 'barista' | 'kitchen') =>
    Math.round(pick(`${k[0].toUpperCase()}${k.slice(1)} staff`, draft.staff?.[k], 0, 10, DEFAULTS.staff.value, DEFAULTS.staff.why));
  const staff: CafeSpec['staff'] = { cashier: staffCount('cashier'), barista: staffCount('barista'), kitchen: staffCount('kitchen') };
  if (staff.cashier === 0) {
    staff.cashier = 1;
    assumptions.push('No cashier: modelled as 1 person taking orders (ASSUMPTION; the simulator needs someone to take each order)');
  }
  if (staff.barista === 0) {
    staff.barista = 1;
    assumptions.push('No barista: modelled as 1 person making drinks and handing over orders (ASSUMPTION)');
  }

  const minutes = (k: 'order' | 'drink' | 'food' | 'handoff') =>
    pick(`Typical ${k} time (min)`, draft.minutes?.[k], 0.1, 60, DEFAULTS.minutes[k].value, DEFAULTS.minutes[k].why);
  const times = {
    order: lognormal(minutes('order'), SPREAD_DEFAULT),
    drink: lognormal(minutes('drink'), SPREAD_DEFAULT),
    food: lognormal(minutes('food'), SPREAD_DEFAULT),
    handoff: lognormal(minutes('handoff'), SPREAD_DEFAULT),
  };
  assumptions.push(`Task-time spread: lognormal sigma ${SPREAD_DEFAULT} (ASSUMPTION)`);

  let prepMode: CafeSpec['prepMode'] = 'parallel';
  if (draft.prepMode === 'parallel' || draft.prepMode === 'sequential') prepMode = draft.prepMode;
  else assumptions.push('Drink + food orders made at the same time (ASSUMPTION)');

  let handoff: CafeSpec['handoff'] = 'barista';
  if (draft.handoff === 'dedicated') {
    handoff = 'dedicated';
    staff.handoff = Math.round(pick('Handoff staff', draft.staff?.handoff, 1, 5, 1, 'ASSUMPTION'));
  } else if (draft.handoff !== 'barista') assumptions.push('The barista hands over orders (ASSUMPTION)');

  if (staff.kitchen === 0 && ((mix.food ?? 0) > 0 || (mix.drinkFood ?? 0) > 0)) {
    // Food with nobody cooking: treat it as ready items handed over at the counter.
    mix = { drink: (mix.drink ?? 0) + (mix.drinkFood ?? 0), food: 0, drinkFood: 0, grabGo: (mix.grabGo ?? 0) + (mix.food ?? 0) };
    assumptions.push('No kitchen staff: food is treated as ready items handed over at the counter; drink + food orders count as drinks (ASSUMPTION)');
  }
  if (staff.kitchen === 0) staff.kitchen = 1; // unused when no orders need the kitchen; keeps the config valid

  const spec: CafeSpec = {
    name: typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim().slice(0, 80) : 'Your café',
    arrivals: constantCurve(perHour / 60, rush),
    mix,
    staff,
    times,
    prepMode,
    handoff,
    measureFromMin: 0,
  };
  assumptions.push('Orders arrive at a steady rate across the rush (ASSUMPTION)');
  if (typeof draft.startsAt === 'string' && /^\d{1,2}:\d{2}$/.test(draft.startsAt)) spec.startsAt = draft.startsAt;
  if (draft.foodBatching && inRange(draft.foodBatching.intervalMin, 5, 60) && inRange(draft.foodBatching.batchSize, 1, 50)) {
    spec.foodBatching = { intervalMin: draft.foodBatching.intervalMin, batchSize: Math.round(draft.foodBatching.batchSize), cookMin: minutes('food') };
  }
  return { spec, draft, assumptions, problems, confirmed: false };
}

export type BuildResult = { ok: true; model: BuiltModel; llmCalls: number } | { ok: false; message: string; llmCalls: number };

export async function buildModelFromDescription(description: string, llm: LlmClient, maxAttempts = 2): Promise<BuildResult> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Extract the café described by the user into the build_model tool. Include only facts the user stated, but do include stated zeros ' +
        '("no kitchen staff" means kitchen 0; "drinks only" means mix 100/0/0). Percentages are 0–100. Use 24-hour HH:MM times.',
    },
    { role: 'user', content: description.slice(0, 2000) },
  ];
  let llmCalls = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await llm.complete({ messages, tools: [BUILD_MODEL_TOOL], toolChoice: 'required', maxTokens: 768 });
    } catch (err) {
      return { ok: false, message: err instanceof LlmLimitError ? 'The daily limit has been reached. Please try again tomorrow.' : 'Sorry, the description could not be processed right now.', llmCalls };
    }
    llmCalls++;
    messages.push(res.message);
    const call = res.message.tool_calls?.[0];
    if (call?.function.name === 'build_model') {
      try {
        const draft = JSON.parse(call.function.arguments || '{}');
        if (typeof draft === 'object' && draft !== null) return { ok: true, model: draftToSpec(draft as CafeDraft), llmCalls };
      } catch {
        /* fall through to retry */
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: '{"error":"Arguments were not valid JSON"}' });
    } else {
      messages.push({ role: 'user', content: 'Call the build_model tool.' });
    }
  }
  return { ok: false, message: 'Sorry, I could not read that description. Try listing staff, orders per hour and typical task times.', llmCalls };
}
