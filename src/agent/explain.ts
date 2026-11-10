// One plain sentence per tested plan, for the results page and what-if
// answers. Only the failed checks are named; the full check list stays
// available behind a "details" toggle in the UI.

import { ORDER_TYPE_LABEL, type OrderType } from '../sim/types';
import type { ExperimentRecord } from './agent';
import { MAX_TIME_IN_CAFE_WORSENING, MAX_TYPE_WORSENING, MIN_IMPROVEMENT } from './evaluate';

export interface Verdict {
  kind: 'accepted' | 'rejected' | 'blocked' | 'invalid';
  /** e.g. "✗ Rejected: bad-case wait got 6% longer." */
  sentence: string;
}

const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const MAX_REASONS = 3;

/** Why each failed check failed, most serious first. */
export function failedReasons(e: ExperimentRecord): string[] {
  if (!e.decision || !e.evidence) return [];
  const failed = new Set(e.decision.checks.filter((c) => !c.passed).map((c) => c.name));
  const n = e.evidence.nominal;
  const out: string[] = [];
  if (failed.has('Every order gets served')) out.push('some orders would never be served');
  if (failed.has('Time in café does not get more than 10% worse')) out.push(`time in the café got ${pct(n.timeInCafe.change)} longer`);
  if (failed.has('No order type gets more than 10% worse')) {
    const worst = (Object.entries(n.byType) as Array<[OrderType, { change: number }]>)
      .filter(([, v]) => v.change > MAX_TYPE_WORSENING)
      .sort((a, b) => b[1].change - a[1].change)[0];
    if (worst) out.push(`${ORDER_TYPE_LABEL[worst[0]].toLowerCase()} waits got ${pct(worst[1].change)} longer`);
  }
  if (failed.has('Bad-case wait improves by at least 10%'))
    // One decimal here, so 9.6% never reads as "only 10% shorter (needs 10%)".
    out.push(n.improvement < 0 ? `bad-case wait got ${pct(n.improvement)} longer` : `bad-case wait only ${(n.improvement * 100).toFixed(1)}% shorter (needs ${pct(MIN_IMPROVEMENT)})`);
  if (failed.has('Improvement is clear of simulation noise') && n.improvement >= 0) out.push('the gain is within simulation noise');
  if (failed.has('Still helps if tasks are 30% faster') && n.improvement > 0) out.push('stops helping if tasks are 30% faster');
  if (failed.has('Still helps if tasks are 30% slower') && n.improvement > 0) out.push('stops helping if tasks are 30% slower');
  return out;
}

export function verdict(e: ExperimentRecord, isBest = false): Verdict {
  if (e.status === 'invalid') return { kind: 'invalid', sentence: `✗ Not possible: ${lowerFirst(e.violations[0] ?? 'this plan cannot be applied')}.` };
  if (e.status === 'blocked') return { kind: 'blocked', sentence: `✗ Not allowed: ${lowerFirst(e.violations.join('; '))}.` };
  if (e.status === 'accepted')
    return { kind: 'accepted', sentence: isBest ? '✓ Recommended.' : '✓ Passed every check, but another plan cuts the bad-case wait more.' };
  const reasons = failedReasons(e);
  const shown = reasons.slice(0, MAX_REASONS);
  const more = reasons.length - shown.length;
  return { kind: 'rejected', sentence: `✗ Rejected: ${shown.join('; ') || 'did not pass the test'}${more > 0 ? ` (and ${more} more)` : ''}.` };
}

export { MAX_TIME_IN_CAFE_WORSENING };
