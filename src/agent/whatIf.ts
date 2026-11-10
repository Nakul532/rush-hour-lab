// What-if chat: "what if i add 4 barista", "2 more cooks 8-9am", "what if we batch waffles".
//
// 1. The AI turns the question into changes (if available). Its output is
//    normalised: missing values get stated defaults, typos in station names
//    are fixed, clock times become rush minutes, windows are clipped to the rush.
// 2. If the AI is unavailable or its changes still don't work, a rule-based
//    reader (whatIfRules.ts) tries the same question.
// 3. The shared plan validator and the owner's limits are checked. If a limit
//    is broken, the answer says which one and simulates the nearest change
//    that fits.
// 4. Code simulates and writes every number. There is no generic error: if
//    nothing can be read, the answer lists what can be asked, with examples.

import { windowMinutes } from '../sim/arrivals';
import { toWindows, type CafeSpec } from '../sim/cafe';
import { ORDER_TYPE_LABEL, type OrderType } from '../sim/types';
import { applyChanges, ChangeError, describeChange, MAX_STAFF_DELTA, parseChanges, STATION_NAMES, validatePlan, type Change, type StationName } from './changes';
import { compare, DEFAULT_SIM, type Comparison, type SimSettings } from './evaluate';
import { LlmLimitError, type ChatMessage, type LlmClient } from './llm';
import { numberFree } from './agent';
import { describeCafe, WHAT_IF_TOOL } from './prompts';
import { constraintBreaks, DEFAULT_COSTS, type ConstraintBreak, type Constraints, type CostTable } from './plan';
import { parseWhatIfRules, parseWindow, stationOf, type RawChange } from './whatIfRules';
import { peakWindow } from './hybrid';

export interface WhatIfSuggestion {
  changes: Change[];
  description: string;
  comparison: Comparison;
}

export interface WhatIfResult {
  ok: boolean;
  /** Plain-English answer. Every number in it comes from code. */
  answer: string;
  /** The changes simulated for the question as asked. */
  changes: Change[];
  comparison: Comparison | null;
  /** The AI's one-line explanation, dropped if it contained numbers. */
  explanation: string | null;
  llmCalls: number;
  /** Who read the question: the AI, or the rule-based reader as a fallback. */
  readBy: 'ai' | 'rules' | null;
  /** Defaults filled in and adjustments made, in plain words. */
  notes: string[];
  /** Limits the question breaks, and the nearest change that fits them. */
  limits: { breaks: ConstraintBreak[]; suggestion: WhatIfSuggestion | null } | null;
}

export interface WhatIfOptions {
  constraints?: Constraints;
  costs?: CostTable;
}

const m = (x: number) => `${x.toFixed(1)} min`;
const MAX_ATTEMPTS = 2;

export const WHAT_IF_HELP =
  'You can ask about: adding or moving staff ("add a barista 8–9am", "move a cashier to the kitchen"), ' +
  'cooking food in batches ("batch the waffles"), selling drinks ready-made ("what if 30% of drinks were grab-and-go"), ' +
  'making drinks and food at the same time, a pickup counter, or an express lane for drinks.';

// ---------------------------------------------------------------- normalising

function clockToMinutes(v: unknown, spec: CafeSpec): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const w = parseWindow(`${v} to ${v}`, spec);
  return w?.fromMin;
}

/** Fill defaults, fix station typos, convert and clip times. Notes say what was assumed. */
export function normalizeChanges(raw: unknown, spec: CafeSpec): { changes: RawChange[]; notes: string[] } {
  const list = Array.isArray(raw) ? raw : [];
  const notes: string[] = [];
  const rush = windowMinutes(spec.arrivals);
  const mixTotal = Object.values(spec.mix).reduce((a, b) => a + (b ?? 0), 0) || 1;
  const foodShare = ((spec.mix.food ?? 0) + (spec.mix.drinkFood ?? 0)) / mixTotal;
  const perMin = spec.arrivals.ratePerMin.reduce((a, b) => a + b, 0) / spec.arrivals.ratePerMin.length;
  const out: RawChange[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const c: RawChange = { ...(item as RawChange) };
    switch (c.kind) {
      case 'staff': {
        if (typeof c.station === 'string' && !STATION_NAMES.includes(c.station as StationName)) {
          const fixed = stationOf(c.station);
          if (fixed) c.station = fixed;
        }
        if (c.station === 'handoff' && spec.handoff !== 'dedicated') {
          out.push({ kind: 'dedicatedHandoff', staff: Math.max(1, Math.abs(Number(c.delta) || 1)) });
          continue;
        }
        if (c.delta === undefined || c.delta === null) c.delta = 1;
        c.delta = Math.round(Number(c.delta));
        if (Math.abs(c.delta as number) > MAX_STAFF_DELTA) {
          notes.push(`${Math.abs(c.delta as number)} is more than one change can add, so I used ${MAX_STAFF_DELTA}.`);
          c.delta = Math.sign(c.delta as number) * MAX_STAFF_DELTA;
        }
        let from = clockToMinutes(c.fromMin, spec);
        let to = clockToMinutes(c.toMin, spec);
        if (from !== undefined || to !== undefined) {
          from = Math.max(0, from ?? 0);
          to = Math.min(rush, to ?? rush);
          if (to <= from) {
            notes.push('That time is outside the rush, so I applied the change to the whole rush.');
            delete c.fromMin;
            delete c.toMin;
          } else {
            if ((typeof c.fromMin === 'number' && c.fromMin < 0) || (typeof c.toMin === 'number' && c.toMin > rush)) notes.push('I cut the time window to fit inside the rush.');
            c.fromMin = from;
            c.toMin = to;
            if (from === 0 && to === rush) {
              delete c.fromMin;
              delete c.toMin;
            }
          }
        }
        break;
      }
      case 'foodBatching': {
        if (!c.intervalMin) c.intervalMin = 15;
        if (!c.batchSize) {
          c.batchSize = Math.max(2, Math.ceil(perMin * foodShare * Number(c.intervalMin)));
          notes.push(`I assumed batches of ${c.batchSize} every ${c.intervalMin} minutes.`);
        }
        break;
      }
      case 'grabGo': {
        let s = Number(c.shareOfDrinks);
        if (!Number.isFinite(s) || s <= 0) {
          s = 0.3;
          notes.push('I assumed 30% of drink-only orders become grab-and-go.');
        }
        if (s > 1) s = s / 100;
        c.shareOfDrinks = Math.min(0.8, s);
        break;
      }
      case 'prepMode':
        if (c.mode !== 'parallel' && c.mode !== 'sequential') c.mode = spec.prepMode === 'parallel' ? 'sequential' : 'parallel';
        if (c.mode === spec.prepMode) {
          notes.push(spec.prepMode === 'parallel' ? 'Drinks and food are already made at the same time.' : 'The drink is already made before the food.');
          continue;
        }
        break;
      case 'dedicatedHandoff':
      case 'expressDrinks':
        if (!c.staff) c.staff = 1;
        break;
    }
    out.push(c);
  }
  return { changes: out, notes };
}

/** A plan that removes too many people: remove fewer until every station keeps someone. */
function nearestValid(spec: CafeSpec, changes: Change[]): Change[] | null {
  const trimmed = changes.map((c) => (c.kind === 'staff' && c.delta < 0 ? { ...c } : c));
  for (let guard = 0; guard < 12 && validatePlan(spec, trimmed).length > 0; guard++) {
    const neg = trimmed.find((c): c is Extract<Change, { kind: 'staff' }> => c.kind === 'staff' && c.delta < -1);
    if (!neg) return null;
    neg.delta += 1;
  }
  return validatePlan(spec, trimmed).length === 0 ? trimmed : null;
}

// ---------------------------------------------------------------- limits

function staffNow(spec: CafeSpec, st: StationName, t: number): number {
  const s = spec.staff[st];
  if (s === undefined) return 0;
  let n = toWindows(s)[0].servers;
  for (const w of toWindows(s)) if (w.fromMin <= t) n = w.servers;
  return n;
}

/** Candidate plans close to the one asked for, in order of how close they are. */
function candidatesNear(spec: CafeSpec, changes: Change[], constraints: Constraints): Change[][] {
  const out: Change[][] = [];
  const adds = changes.filter((c): c is Extract<Change, { kind: 'staff' }> => c.kind === 'staff' && c.delta > 0);
  const rest = changes.filter((c) => !(c.kind === 'staff' && c.delta > 0));
  const peak = peakWindow(spec);
  const rates = spec.arrivals.ratePerMin;
  const flat = rates.every((r) => Math.abs(r - rates[0]) < 1e-9);

  if (constraints.noNewHires && adds.length) {
    // Move people from stations that have more than one, instead of hiring.
    const moved: Change[] = [...rest];
    const spare: Partial<Record<StationName, number>> = {};
    for (const st of STATION_NAMES) spare[st] = Math.max(0, staffNow(spec, st, 0) - 1);
    for (const a of adds) {
      let need = a.delta;
      for (const donor of STATION_NAMES) {
        if (donor === a.station || need === 0 || !spare[donor]) continue;
        const k = Math.min(need, spare[donor]!);
        spare[donor]! -= k;
        need -= k;
        const win = a.fromMin !== undefined ? { fromMin: a.fromMin, toMin: a.toMin } : {};
        moved.push({ kind: 'staff', station: donor, delta: -k, ...win }, { kind: 'staff', station: a.station, delta: k, ...win });
      }
    }
    if (moved.length > rest.length) out.push(moved);
  }
  // Fewer people, then only the busiest half hour.
  for (const one of [true, false]) {
    const shrunk = adds.map((a) => ({ ...a, delta: one ? 1 : a.delta }));
    if (one && adds.some((a) => a.delta > 1)) out.push([...rest, ...shrunk]);
    if (!flat) out.push([...rest, ...shrunk.map((a) => ({ ...a, delta: 1, fromMin: peak.fromMin, toMin: peak.toMin }))]);
  }
  // Too many changes: keep the first ones.
  if (constraints.maxChanges !== undefined && changes.length > constraints.maxChanges) out.push(changes.slice(0, constraints.maxChanges));
  // Changes that relieve the same station without extra people.
  for (const a of adds) {
    if (a.station === 'barista') out.push([{ kind: 'grabGo', shareOfDrinks: 0.3 }]);
    if (a.station === 'kitchen' && !spec.foodBatching) {
      const n = normalizeChanges([{ kind: 'foodBatching' }], spec).changes as Change[];
      out.push(n);
      if (spec.prepMode === 'sequential') out.push([{ kind: 'prepMode', mode: 'parallel' }]);
    }
  }
  return out;
}

export function nearestAllowed(spec: CafeSpec, changes: Change[], constraints: Constraints, costs: CostTable): Change[] | null {
  for (const cand of candidatesNear(spec, changes, constraints)) {
    if (cand.length === 0) continue;
    if (validatePlan(spec, cand).length > 0) continue;
    if (constraintBreaks(spec, cand, constraints, costs).length > 0) continue;
    return cand;
  }
  return null;
}

// ---------------------------------------------------------------- answer

const describeAll = (spec: CafeSpec, changes: Change[]) =>
  changes.map((c, i) => {
    const d = describeChange(c, spec.startsAt);
    return i === 0 ? d : d[0].toLowerCase() + d.slice(1);
  }).join(', and ');

export function formatWhatIfAnswer(spec: CafeSpec, changes: Change[], c: Comparison): string {
  const dir = c.diff.mean >= 0 ? 'shorter' : 'longer';
  const types = (Object.entries(c.byType) as Array<[OrderType, Comparison['byType'][OrderType]]>)
    .map(([t, v]) => `${ORDER_TYPE_LABEL[t]} ${m(v!.baseP90)} → ${m(v!.candidateP90)}`)
    .join(', ');
  return (
    `SIMULATED: ${describeAll(spec, changes)}. Bad-case (90th percentile) wait goes from ${m(c.baseP90)} to ${m(c.candidateP90)}, ` +
    `${Math.abs(c.improvement * 100).toFixed(0)}% ${dir} (paired 95% CI of the change: ${m(c.diff.low)} to ${m(c.diff.high)}). ` +
    `By order type: ${types}. Time in café: ${m(c.timeInCafe.baseP90)} → ${m(c.timeInCafe.candidateP90)}. This is a simulation, not a guarantee.`
  );
}

async function readWithAi(spec: CafeSpec, question: string, llm: LlmClient): Promise<{ raw: unknown | null; explanation: string | null; calls: number; limitHit: boolean }> {
  const rush = windowMinutes(spec.arrivals);
  const clock = spec.startsAt
    ? `The rush starts at ${spec.startsAt} and lasts ${rush} minutes. Minutes count from the start: ${spec.startsAt} is minute 0, one hour later is minute 60.`
    : `The rush lasts ${rush} minutes; minutes count from its start.`;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        "Translate the café owner's what-if question into changes for the what_if tool. People write casually and with typos: " +
        '"add 4 barista" = staff barista delta 4; "2 more cooks 8-9am" = staff kitchen delta 2 with fromMin/toMin for 8:00–9:00; ' +
        '"batch waffles" = foodBatching (leave intervalMin and batchSize out if not given); "the till" = cashier; "pickup" = a dedicated handoff point. ' +
        '"Batch brew" or "drip" coffee means drinks sold ready-made (grabGo), not food batching. ' +
        'A stated total ("if we had 2 cooks") means the difference from today\'s staff, shown in the café description. ' +
        `${clock} Use the change the owner asked for even if it seems large; code checks their limits. ` +
        'If the question cannot be expressed with the available changes, call what_if with changes [] and say so in the explanation. No numbers in the explanation.',
    },
    { role: 'user', content: `${describeCafe(spec)}\nQuestion: ${question}` },
  ];
  let calls = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await llm.complete({ messages, tools: [WHAT_IF_TOOL], toolChoice: 'required', maxTokens: 512 });
    } catch (err) {
      return { raw: null, explanation: null, calls, limitHit: err instanceof LlmLimitError };
    }
    calls++;
    messages.push(res.message);
    const call = res.message.tool_calls?.[0];
    try {
      if (!call || !/what_if$/.test(call.function.name)) throw new ChangeError('Call the what_if tool');
      const args = JSON.parse(call.function.arguments || '{}');
      const explanation = numberFree(args.explanation);
      const { changes } = normalizeChanges(args.changes, spec);
      if (changes.length === 0) return { raw: [], explanation, calls, limitHit: false };
      parseChanges(changes, spec); // throws if still not usable
      return { raw: args.changes, explanation, calls, limitHit: false };
    } catch (err) {
      const message = err instanceof SyntaxError ? 'Arguments were not valid JSON' : err instanceof Error ? err.message : String(err);
      if (call) messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: message }) });
      else messages.push({ role: 'user', content: message });
    }
  }
  return { raw: null, explanation: null, calls, limitHit: false };
}

export async function answerWhatIf(
  spec: CafeSpec, question: string, llm: LlmClient | null, sim: SimSettings = DEFAULT_SIM, opts: WhatIfOptions = {},
): Promise<WhatIfResult> {
  const constraints = opts.constraints ?? {};
  const costs = opts.costs ?? DEFAULT_COSTS;
  const notes: string[] = [];
  let explanation: string | null = null;
  let llmCalls = 0;
  let readBy: WhatIfResult['readBy'] = null;
  let changes: Change[] = [];
  let invalidReason: string | null = null;

  // With no rush start time, clock times can't be placed: use the whole rush (and say so below).
  const clockTimeWithoutStart = !spec.startsAt && /\d{1,2}(:\d{2})?\s*(am|pm)?\s*(-|–|to|till|until)\s*\d/i.test(question);
  const tryRaw = (raw: unknown): Change[] | null => {
    if (clockTimeWithoutStart && Array.isArray(raw))
      raw = (raw as RawChange[]).map((c) => {
        const { fromMin: _f, toMin: _t, ...rest } = c;
        void _f;
        void _t;
        return rest;
      });
    const n = normalizeChanges(raw, spec);
    if (n.changes.length === 0) return null;
    try {
      const parsed = parseChanges(n.changes, spec);
      notes.push(...n.notes);
      return parsed;
    } catch (err) {
      // Removing too many people: try removing fewer before giving up.
      try {
        const loose = n.changes.map((c) => c as Change);
        const fixed = nearestValid(spec, loose);
        if (fixed) {
          notes.push(...n.notes, 'That would leave a station with nobody on it, so I removed fewer people.');
          return fixed;
        }
      } catch {
        /* not fixable */
      }
      invalidReason = err instanceof Error ? err.message : String(err);
      return null;
    }
  };

  if (llm) {
    const ai = await readWithAi(spec, question, llm);
    llmCalls = ai.calls;
    explanation = ai.explanation;
    if (ai.raw && Array.isArray(ai.raw)) {
      // Code knows the real busiest half hour; the AI only guesses it.
      const peak = /\b(busiest|peak)\b/i.test(question) ? peakWindow(spec) : null;
      for (const c of ai.raw as RawChange[]) {
        if (peak && c.kind === 'staff') Object.assign(c, peak);
        if (c.kind === 'grabGo' && typeof c.shareOfDrinks === 'number') c.shareOfDrinks = Math.round(c.shareOfDrinks * 100) / 100;
      }
    }
    if (ai.raw) {
      const c = tryRaw(ai.raw);
      if (c) {
        changes = c;
        readBy = 'ai';
      }
    }
    if (ai.limitHit) notes.push("The AI has reached today's limit, so a simpler reader handled your question.");
  }
  if (changes.length === 0) {
    const rules = parseWhatIfRules(question, spec);
    const c = tryRaw(rules.changes);
    if (c) {
      changes = c;
      readBy = 'rules';
    }
  }

  const base = { changes: [], comparison: null, explanation, llmCalls, readBy, notes, limits: null };
  if (changes.length === 0) {
    const lead = invalidReason
      ? `I can't simulate that: ${String(invalidReason).replace(/^The plan /, 'it ')}.`
      : explanation ?? "I couldn't match that to a change this simulator can test.";
    return { ...base, ok: false, answer: `${lead} ${WHAT_IF_HELP}` };
  }

  if (clockTimeWithoutStart)
    notes.push("Your rush has no start time set, so I couldn't place that time and applied the change to the whole rush. You can set the start time in step 2.");
  const comparison = compare(spec, applyChanges(spec, changes), sim);
  let answer = formatWhatIfAnswer(spec, changes, comparison);
  if (notes.length) answer += ` ${notes.join(' ')}`;

  let limits: WhatIfResult['limits'] = null;
  const breaks = constraintBreaks(spec, changes, constraints, costs);
  if (breaks.length) {
    const near = nearestAllowed(spec, changes, constraints, costs);
    const suggestion = near ? { changes: near, description: describeAll(spec, near), comparison: compare(spec, applyChanges(spec, near), sim) } : null;
    limits = { breaks, suggestion };
    answer += ` This breaks your limit: ${breaks.map((b) => b.message[0].toLowerCase() + b.message.slice(1)).join('; ')}.`;
    if (suggestion) {
      const s = suggestion.comparison;
      answer += ` Nearest change within your limits: ${suggestion.description[0].toLowerCase()}${suggestion.description.slice(1)}. Bad-case wait ${m(s.baseP90)} → ${m(s.candidateP90)} (${Math.abs(s.improvement * 100).toFixed(0)}% ${s.diff.mean >= 0 ? 'shorter' : 'longer'}).`;
    } else {
      answer += ' I could not find a similar change within your limits.';
    }
  }
  return { ok: true, answer, changes, comparison, explanation, llmCalls, readBy, notes, limits };
}
