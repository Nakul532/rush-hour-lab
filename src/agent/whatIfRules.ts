// Rule-based reader for what-if questions. Used when the AI is unavailable or
// its answer can't be turned into a valid change. Handles casual phrasing,
// typos, number words, clock times ("8-9am", "from 7:30 to 8") and synonyms
// ("till", "cook", "pickup"). Returns raw changes for normalizeChanges().

import { windowMinutes } from '../sim/arrivals';
import type { CafeSpec } from '../sim/cafe';
import type { StationName } from './changes';
import { peakWindow } from './hybrid';

export type RawChange = Record<string, unknown>;

export interface RuleParse {
  changes: RawChange[];
  /** What the reader understood, in plain words (shown to the user). */
  understood: string[];
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, another: 1, extra: 1, second: 1, single: 1,
  two: 2, couple: 2, pair: 2, three: 3, four: 4, five: 5, six: 6,
};

const STATION_WORDS: Array<[StationName, string[]]> = [
  ['barista', ['barista', 'baristas', 'bar', 'barman', 'espresso', 'coffee person', 'drinks person']],
  ['cashier', ['cashier', 'cashiers', 'till', 'register', 'checkout', 'front', 'pos', 'order taker']],
  ['kitchen', ['kitchen', 'cook', 'cooks', 'chef', 'chefs', 'grill', 'toaster', 'line cook', 'waffle iron', 'food person', 'kitchen staff']],
  ['handoff', ['pickup', 'pick-up', 'pick up', 'handoff', 'hand-off', 'runner', 'pass', 'expo']],
];

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Station named by a word, allowing small typos ("barsita", "cahsier", "kichen"). */
export function stationOf(word: string): StationName | null {
  const w = word.toLowerCase().replace(/[^a-z-]/g, '');
  if (w.length < 3) return null;
  for (const [st, words] of STATION_WORDS) if (words.includes(w)) return st;
  if (w.length < 5) return null;
  let best: { st: StationName; d: number } | null = null;
  for (const [st, words] of STATION_WORDS)
    for (const cand of words) {
      if (cand.includes(' ') || cand.length < 5) continue;
      const d = lev(w, cand);
      if (d <= (cand.length >= 7 ? 2 : 1) && (!best || d < best.d)) best = { st, d };
    }
  return best?.st ?? null;
}

function findStations(text: string): Array<{ st: StationName; at: number }> {
  const out: Array<{ st: StationName; at: number }> = [];
  const lower = text.toLowerCase();
  for (const [st, words] of STATION_WORDS)
    for (const w of words) if (w.includes(' ')) {
      const i = lower.indexOf(w);
      if (i >= 0) out.push({ st, at: i });
    }
  const re = /[a-z-]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // "till" is the register only as a noun ("on the till"), not "7:45 till 8:15".
    if (m[0].toLowerCase() === 'till' && !/\b(the|a|on|at the)\s+$/i.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
    const st = stationOf(m[0]);
    if (st && !out.some((o) => o.at <= m!.index && m!.index < o.at + 12)) out.push({ st, at: m.index });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The number just before a station word ("2 more cooks", "three baristas", "a barista"). */
function countBefore(clause: string, at: number): number {
  const words = (clause.slice(Math.max(0, at - 30), at).toLowerCase().match(/[a-z]+|\d+/g) ?? []).slice(-4);
  // An explicit count ("2", "three", "a couple") wins over "a", "another", "extra".
  for (let i = words.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(words[i])) return Math.min(10, Number(words[i]));
    if ((NUMBER_WORDS[words[i]] ?? 0) > 1) return NUMBER_WORDS[words[i]];
  }
  return 1;
}

function toMinutes(h: number, m: number, ampm: string | undefined, spec: CafeSpec): number | null {
  if (!spec.startsAt) return null;
  const [sh, sm] = spec.startsAt.split(':').map(Number);
  const start = sh * 60 + sm;
  const rush = windowMinutes(spec.arrivals);
  const options = ampm ? [((h % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0)) * 60 + m] : [h * 60 + m, (h + 12) * 60 + m];
  // Pick the reading that falls closest to the rush.
  let best: number | null = null;
  let bestDist = Infinity;
  for (const t of options) {
    const rel = t - start;
    const dist = rel < 0 ? -rel : rel > rush ? rel - rush : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = rel;
    }
  }
  return best;
}

/** A time window in minutes from the rush start, if the question names one. */
export function parseWindow(text: string, spec: CafeSpec): { fromMin: number; toMin: number; label: string } | null {
  if (/\b(busiest|peak)\b/i.test(text)) {
    const p = peakWindow(spec);
    return { ...p, label: 'the busiest half hour' };
  }
  const t = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?';
  const re = new RegExp(`(?:from|between|at)?\\s*${t}\\s*(?:-|–|—|to|till|until|and)\\s*${t}`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const ap1 = m[3]?.replace(/\./g, '');
  const ap2 = m[6]?.replace(/\./g, '');
  const from = toMinutes(Number(m[1]), Number(m[2] ?? 0), ap1 ?? ap2, spec);
  const to = toMinutes(Number(m[4]), Number(m[5] ?? 0), ap2 ?? ap1, spec);
  if (from === null || to === null || to <= from) return null;
  return { fromMin: from, toMin: to, label: m[0].trim() };
}

function currentStaff(spec: CafeSpec, st: StationName): number {
  const s = spec.staff[st];
  if (s === undefined) return 0;
  return typeof s === 'number' ? s : s[0].servers;
}

function sharePct(text: string): number | null {
  const m = text.match(/(\d{1,2})\s*(%|percent)/i);
  if (m) return Number(m[1]) / 100;
  if (/\b(a|one)[ -]third\b/i.test(text)) return 0.33;
  if (/\bhalf\b/i.test(text)) return 0.5;
  if (/\b(a|one)[ -]quarter\b/i.test(text)) return 0.25;
  return null;
}

export function parseWhatIfRules(question: string, spec: CafeSpec): RuleParse {
  const q = question.toLowerCase();
  const changes: RawChange[] = [];
  const understood: string[] = [];
  const window = parseWindow(q, spec);
  const win = window ? { fromMin: window.fromMin, toMin: window.toMin } : {};

  // Menu and process changes.
  if (/grab[\s-]*(and|&|n)?[\s-]*go|\bdrip\b|ready[\s-]*(made|to[\s-]go)|pre[\s-]*made|batch[\s-]*brew|airpot/.test(q)) {
    const share = sharePct(q);
    changes.push({ kind: 'grabGo', ...(share !== null ? { shareOfDrinks: share } : {}) });
    understood.push('sell some drinks ready-made (grab-and-go)');
  } else if (/\bbatch(es|ing|ed)?\b/.test(q)) {
    const size = q.match(/batch(?:es)? of (\d+)/)?.[1];
    const every = q.match(/every (\d+)\s*(?:min|minutes)?/)?.[1];
    changes.push({ kind: 'foodBatching', ...(size ? { batchSize: Number(size) } : {}), ...(every ? { intervalMin: Number(every) } : {}) });
    understood.push('cook food in batches');
  }
  if (/same time|parallel|simultaneous|at once|together/.test(q) && !/staff|barista|cook/.test(q.replace(/same time/, ''))) {
    changes.push({ kind: 'prepMode', mode: 'parallel' });
    understood.push('make drinks and food at the same time');
  } else if (/(drink|coffee)s? first|one after|then (the )?food|sequential/.test(q)) {
    changes.push({ kind: 'prepMode', mode: 'sequential' });
    understood.push('make the drink first, then the food');
  }
  if (/\bexpress\b/.test(q)) {
    changes.push({ kind: 'expressDrinks', staff: 1 });
    understood.push('an express station for drink-only orders');
  }

  // Staff: moves first ("move a cashier to the kitchen"), then adds/removes per clause.
  const move = q.match(/\b(?:move|switch|shift|send|put)\b(.*?)\b(?:to|onto|on)\b(.*)/);
  const moveFrom = move ? findStations(move[1])[0] : undefined;
  const moveTo = move ? findStations(move[2])[0] : undefined;
  if (move && moveFrom && moveTo && moveFrom.st !== moveTo.st) {
    const k = countBefore(move[1], moveFrom.at);
    changes.push({ kind: 'staff', station: moveFrom.st, delta: -k, ...win }, { kind: 'staff', station: moveTo.st, delta: k, ...win });
    understood.push(`move ${k} from ${moveFrom.st} to ${moveTo.st}${window ? ` (${window.label})` : ''}`);
  } else {
    for (const clause of q.split(/\band\b|\bn\b|&|,|\bplus\b|;/)) {
      // "if we had 2 cooks" states a total, not an addition.
      const statesTotal = /\b(have|had|hav|with|having)\b/.test(clause) && !/\b(add|more|extra|another|hire|plus|second)\b/.test(clause);
      for (const s of findStations(clause)) {
        if (s.st === 'handoff' && spec.handoff !== 'dedicated') {
          changes.push({ kind: 'dedicatedHandoff', staff: 1 });
          understood.push('a dedicated pickup point with 1 person');
          continue;
        }
        const negative = /\b(remove|fewer|less|cut|drop|lose|without|minus|take away|one less)\b/.test(clause) || /\btake\b.*\boff\b/.test(clause);
        // A count right before the station ("4 barista", "two cooks") also means "add"; a time like "at 8" does not.
        const countJustBefore = /(\d+|two|three|four|five|six|couple)\s+(?:[a-z]+\s+)?$/.test(clause.slice(Math.max(0, s.at - 20), s.at));
        const positive = /\b(add|more|extra|another|hire|second|put|have|get|bring|plus|double)\b/.test(clause) || countJustBefore;
        if (!negative && !positive) continue;
        const k = countBefore(clause, s.at);
        let delta = negative ? -k : k;
        if (statesTotal && !negative && countJustBefore) {
          const now = currentStaff(spec, s.st);
          delta = k - now;
          if (delta === 0) {
            understood.push(`you already have ${k} ${s.st}`);
            continue;
          }
        }
        changes.push({ kind: 'staff', station: s.st, delta, ...win });
        understood.push(`${delta > 0 ? 'add' : 'remove'} ${Math.abs(delta)} ${s.st}${window ? ` (${window.label})` : ''}`);
      }
    }
  }
  return { changes, understood };
}
