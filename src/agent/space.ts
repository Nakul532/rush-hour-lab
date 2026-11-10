// A small, fixed change space for evaluation: a few levers, each with a few
// options (plus "leave as is"). A plan picks at most one option per lever.
// Small enough to brute-force, so we know the truly best plan.

import type { CafeSpec } from '../sim/cafe';
import { ChangeError, parseChanges, type Change } from './changes';

export interface LeverOption {
  label: string;
  changes: Change[];
}

export interface Lever {
  id: string;
  label: string;
  options: LeverOption[];
}

export type ChangeSpace = Lever[];

/** Index of the chosen option per lever; -1 = leave as is. */
export type Choice = number[];

export function spaceSize(space: ChangeSpace): number {
  return space.reduce((n, l) => n * (l.options.length + 1), 1);
}

export function* enumerateChoices(space: ChangeSpace): Generator<Choice> {
  const choice = space.map(() => -1);
  for (;;) {
    yield [...choice];
    let i = 0;
    while (i < space.length) {
      choice[i]++;
      if (choice[i] < space[i].options.length) break;
      choice[i] = -1;
      i++;
    }
    if (i === space.length) return;
  }
}

export function choiceChanges(space: ChangeSpace, choice: Choice): Change[] {
  return choice.flatMap((c, i) => (c < 0 ? [] : space[i].options[c].changes));
}

export function choiceKey(choice: Choice): string {
  return choice.join(',');
}

export function describeChoice(space: ChangeSpace, choice: Choice): string {
  const parts = choice.flatMap((c, i) => (c < 0 ? [] : [space[i].options[c].label]));
  return parts.length ? parts.join(' + ') : 'No change';
}

const canon = (c: Change) => JSON.stringify(Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b))));

/**
 * Map a plan the agent proposed back to a choice in the space. Each lever
 * option must appear whole; leftover changes, or two options of one lever,
 * mean the plan is outside the space.
 */
export function matchPlan(space: ChangeSpace, changes: Change[], spec: CafeSpec): Choice {
  const remaining = changes.map(canon);
  const choice: Choice = space.map(() => -1);
  space.forEach((lever, i) => {
    lever.options.forEach((opt, j) => {
      // Normalise the option the same way the agent's changes were parsed.
      const want = parseChanges(opt.changes, spec).map(canon);
      if (want.every((w) => remaining.includes(w))) {
        if (choice[i] >= 0) throw new ChangeError(`Use at most one option from "${lever.label}"`);
        choice[i] = j;
        for (const w of want) remaining.splice(remaining.indexOf(w), 1);
      }
    });
  });
  if (remaining.length > 0) throw new ChangeError(`Not one of the allowed options: ${remaining.join(', ')}. Use only the options listed.`);
  return choice;
}

/** Compact listing for the prompt. */
export function describeSpace(space: ChangeSpace): string {
  return [
    'Allowed options (at most one per group; combine groups freely). Copy the changes exactly:',
    ...space.map((l) => `- ${l.label}: ${l.options.map((o) => `${o.label} = ${JSON.stringify(o.changes)}`).join(' | ')}`),
  ].join('\n');
}
