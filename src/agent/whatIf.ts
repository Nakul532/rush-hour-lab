// What-if chat: "What if I add a barista from 8 to 10?"
// The LLM only turns the question into changes. Code simulates both cafés
// on the same customers and writes every number in the answer.

import type { CafeSpec } from '../sim/cafe';
import { ORDER_TYPE_LABEL, type OrderType } from '../sim/types';
import { applyChanges, ChangeError, describeChange, parseChanges, type Change } from './changes';
import { compare, DEFAULT_SIM, type Comparison, type SimSettings } from './evaluate';
import { LlmLimitError, type ChatMessage, type LlmClient } from './llm';
import { numberFree } from './agent';
import { describeCafe, WHAT_IF_TOOL } from './prompts';

export interface WhatIfResult {
  ok: boolean;
  /** Plain-English answer. Every number in it comes from code. */
  answer: string;
  changes: Change[];
  comparison: Comparison | null;
  /** The LLM's one-line explanation, dropped if it contained numbers. */
  explanation: string | null;
  llmCalls: number;
}

const m = (x: number) => `${x.toFixed(1)} min`;

export function formatWhatIfAnswer(spec: CafeSpec, changes: Change[], c: Comparison): string {
  const what = changes.map((ch) => describeChange(ch, spec.startsAt)).join('; ');
  const dir = c.diff.mean >= 0 ? 'shorter' : 'longer';
  const types = (Object.entries(c.byType) as Array<[OrderType, Comparison['byType'][OrderType]]>)
    .map(([t, v]) => `${ORDER_TYPE_LABEL[t]} ${m(v!.baseP90)} → ${m(v!.candidateP90)}`)
    .join(', ');
  return (
    `SIMULATED: ${what}. Bad-case (90th percentile) wait goes from ${m(c.baseP90)} to ${m(c.candidateP90)}, ` +
    `${Math.abs(c.improvement * 100).toFixed(0)}% ${dir} (paired 95% CI of the change: ${m(c.diff.low)} to ${m(c.diff.high)}). ` +
    `By order type: ${types}. This is a simulation, not a guarantee.`
  );
}

export async function answerWhatIf(spec: CafeSpec, question: string, llm: LlmClient, sim: SimSettings = DEFAULT_SIM, maxAttempts = 2): Promise<WhatIfResult> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Translate the café owner\'s what-if question into changes for the what_if tool. Minutes count from the start of the rush. ' +
        'If the question cannot be expressed with the available changes, call what_if with changes [] and say so in the explanation. No numbers in the explanation.',
    },
    { role: 'user', content: `${describeCafe(spec)}\nQuestion: ${question}` },
  ];
  let llmCalls = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await llm.complete({ messages, tools: [WHAT_IF_TOOL], toolChoice: 'required', maxTokens: 512 });
    } catch (err) {
      const limit = err instanceof LlmLimitError;
      return { ok: false, answer: limit ? 'The daily limit for questions has been reached. Please try again tomorrow.' : 'Sorry, the question could not be processed right now.', changes: [], comparison: null, explanation: null, llmCalls };
    }
    llmCalls++;
    messages.push(res.message);
    const call = res.message.tool_calls?.[0];
    try {
      if (!call || call.function.name !== 'what_if') throw new ChangeError('Call the what_if tool');
      const args = JSON.parse(call.function.arguments || '{}');
      const changes = parseChanges(args.changes ?? [], spec);
      const explanation = numberFree(args.explanation);
      if (changes.length === 0) {
        return { ok: false, answer: explanation ?? 'That question cannot be tested with the changes this simulator supports.', changes, comparison: null, explanation, llmCalls };
      }
      const comparison = compare(spec, applyChanges(spec, changes), sim);
      return { ok: true, answer: formatWhatIfAnswer(spec, changes, comparison), changes, comparison, explanation, llmCalls };
    } catch (err) {
      const message = err instanceof SyntaxError ? 'Arguments were not valid JSON' : err instanceof Error ? err.message : String(err);
      if (call) messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: message }) });
      else messages.push({ role: 'user', content: message });
    }
  }
  return { ok: false, answer: 'Sorry, I could not turn that question into a change I can simulate. Try rephrasing it.', changes: [], comparison: null, explanation: null, llmCalls };
}
