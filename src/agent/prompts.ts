// Prompts and tool definitions. Kept short: the live test has a 40K-token cap.

import { windowMinutes } from '../sim/arrivals';
import { toWindows, type CafeSpec } from '../sim/cafe';
import type { Dist } from '../sim/distributions';
import type { ToolSpec } from './llm';
import type { Constraints, CostTable } from './plan';

export const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

const CHANGE_SCHEMA = {
  type: 'object',
  description:
    'One change. kinds: staff {station: cashier|barista|kitchen|handoff|express, delta: -3..3, fromMin?, toMin?}; ' +
    'prepMode {mode: parallel|sequential}; foodBatching {intervalMin: 5-60, batchSize: 1-50, cookMin?}; ' +
    'dedicatedHandoff {staff: 1-3}; expressDrinks {staff: 1-3}; grabGo {shareOfDrinks: 0-0.8}',
  properties: { kind: { type: 'string', enum: ['staff', 'prepMode', 'foodBatching', 'dedicatedHandoff', 'expressDrinks', 'grabGo'] } },
  required: ['kind'],
  additionalProperties: true,
};
const CHANGES = { type: 'array', items: CHANGE_SCHEMA, description: 'Changes applied to the current café, in order. [] = no change.' };

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const AGENT_TOOLS: ToolSpec[] = [
  tool('run_simulation', 'Simulate the café with some changes. Returns p90 and median waits, staff utilization and queues.', { changes: CHANGES }, ['changes']),
  tool('find_bottleneck', 'Busiest station of the café with some changes.', { changes: CHANGES }, ['changes']),
  tool('compare', 'Compare two plans on the same simulated customers.', { changes_a: CHANGES, changes_b: CHANGES }, ['changes_a', 'changes_b']),
  tool('sensitivity', 'Compare a plan with today, with all task times 30% shorter and 30% longer.', { changes: CHANGES }, ['changes']),
  tool(
    'test_change',
    'Formally test a plan against today. Uses one experiment. Code applies the acceptance rule and records the result.',
    { hypothesis: { type: 'string', description: 'Why you expect this to help, in one sentence.' }, changes: CHANGES },
    ['hypothesis', 'changes'],
  ),
  tool('finish', 'Stop experimenting. The app shows all numbers itself.', { summary: { type: 'string', description: 'Two sentences, no numbers.' } }, ['summary']),
];

export const WHAT_IF_TOOL: ToolSpec = tool(
  'what_if',
  "Turn the user's what-if question into changes to simulate.",
  {
    changes: CHANGES,
    explanation: { type: 'string', description: 'One sentence on what you are changing. No numbers.' },
  },
  ['changes', 'explanation'],
);

export const BUILD_MODEL_TOOL: ToolSpec = tool(
  'build_model',
  'Record the café described by the user. Leave out anything they did not say; do not guess.',
  {
    name: { type: 'string' },
    rushMinutes: { type: 'number', description: 'Length of the rush in minutes' },
    startsAt: { type: 'string', description: 'Rush start, HH:MM 24-hour' },
    ordersPerHour: { type: 'number' },
    mixPercent: {
      type: 'object',
      properties: { drink: { type: 'number' }, food: { type: 'number' }, drinkFood: { type: 'number' }, grabGo: { type: 'number' } },
      additionalProperties: false,
    },
    staff: {
      type: 'object',
      properties: { cashier: { type: 'integer' }, barista: { type: 'integer' }, kitchen: { type: 'integer' }, handoff: { type: 'integer' } },
      additionalProperties: false,
    },
    minutes: {
      type: 'object',
      description: 'Typical minutes per task',
      properties: { order: { type: 'number' }, drink: { type: 'number' }, food: { type: 'number' }, handoff: { type: 'number' } },
      additionalProperties: false,
    },
    prepMode: { type: 'string', enum: ['parallel', 'sequential'] },
    handoff: { type: 'string', enum: ['barista', 'dedicated'] },
    foodBatching: {
      type: 'object',
      properties: { intervalMin: { type: 'number' }, batchSize: { type: 'integer' } },
      required: ['intervalMin', 'batchSize'],
      additionalProperties: false,
    },
  },
  [],
);

const distText = (d: Dist) => (d.kind === 'lognormal' ? `${r1(d.median)}` : d.kind === 'exponential' ? `${r1(d.mean)}` : `${r1(d.value)}`);
const staffText = (s: number | { fromMin: number; servers: number }[] | undefined) =>
  s === undefined ? 'none' : toWindows(s).map((w) => (w.fromMin === 0 ? `${w.servers}` : `${w.servers} from min ${w.fromMin}`)).join(', ');

/** A compact plain-text description of the café for the prompt. */
export function describeCafe(spec: CafeSpec): string {
  const total = Object.values(spec.mix).reduce((a, b) => a + (b ?? 0), 0);
  const mix = Object.entries(spec.mix)
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([k, v]) => `${k} ${Math.round(((v ?? 0) / total) * 100)}%`)
    .join(', ');
  const rate = spec.arrivals.ratePerMin.map((r) => r1(r * 60)).join(',');
  return [
    `Rush: ${windowMinutes(spec.arrivals)} min${spec.startsAt ? ` from ${spec.startsAt}` : ''}; orders/hour per ${spec.arrivals.bucketMinutes}-min block: ${rate}.`,
    `Order mix: ${mix}.`,
    `Staff: cashier ${staffText(spec.staff.cashier)}; barista ${staffText(spec.staff.barista)}; kitchen ${staffText(spec.staff.kitchen)}` +
      (spec.handoff === 'dedicated' ? `; handoff ${staffText(spec.staff.handoff)}` : '; barista hands over orders') +
      (spec.drinkOnlyStation === 'express' ? `; express drinks ${staffText(spec.staff.express)}` : '') +
      '.',
    `Typical task minutes: order ${distText(spec.times.order)}, drink ${distText(spec.times.drink)}, food ${distText(spec.times.food)}, handoff ${distText(spec.times.handoff)}.`,
    `Drink + food orders: ${spec.prepMode === 'parallel' ? 'made at the same time' : 'drink first, then food'}.` +
      (spec.foodBatching ? ` Food cooked in batches of ${spec.foodBatching.batchSize} every ${spec.foodBatching.intervalMin} min.` : ''),
  ].join('\n');
}

export function describeConstraints(c: Constraints, costs: CostTable): string {
  const parts = [
    c.noNewHires ? 'No new hires: total staff on shift can never exceed today (you may move people between stations).' : 'Hiring is allowed.',
    c.maxChanges !== undefined ? `At most ${c.maxChanges} changes per plan.` : '',
    c.budgetUsd !== undefined
      ? `Budget $${c.budgetUsd} for the first month. Costs: staff $${costs.staffHourly}/hour for ${costs.rushDaysPerMonth} rush days; batching $${costs.foodBatching}; handoff point $${costs.dedicatedHandoffSetup}; express station $${costs.expressDrinksSetup}; grab-and-go $${costs.grabGoSetup}.`
      : '',
  ];
  return parts.filter(Boolean).join(' ');
}

export function agentSystemPrompt(maxExperiments: number, maxCalls: number): string {
  return [
    'You are an operations analyst for a small café. Goal: shorten the bad-case wait (90th-percentile wait, "p90") without breaking the owner\'s constraints.',
    'You only learn about the café through tools. Call exactly one tool per turn.',
    `Budget: ${maxExperiments} test_change experiments and ${maxCalls} tool calls in total. Then you must call finish.`,
    'Code decides acceptance, not you. A plan is accepted only if: overall p90 improves by at least 10%; the paired 95% CI of the improvement excludes zero; it still improves with task times 30% shorter and 30% longer; and no order type\'s p90 gets more than 10% worse.',
    'Work like a scientist: look at the bottleneck, form a hypothesis, test it, learn from the result, then test the next idea. Prefer cheap changes. Try combining changes that were accepted.',
    'Minutes in changes count from the start of the rush. Keep text short. finish.summary must contain no digits.',
  ].join('\n');
}
