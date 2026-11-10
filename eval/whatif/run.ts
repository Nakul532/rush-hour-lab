// npm run eval:whatif -- [--live]
// Runs the locked what-if phrasing set (eval/whatif/cases.ts) with the
// rule-based reader alone, and (with --live) with the AI reader in front.
// Writes eval/results-whatif/{rules,ai}.json and prints the success rates.

import { mkdirSync, writeFileSync } from 'node:fs';
import { loadEnvKey } from '../../src/agent/env';
import { OpenRouterLlm } from '../../src/agent/openrouter';
import { validatePlan, type Change } from '../../src/agent/changes';
import { constraintBreaks, DEFAULT_COSTS } from '../../src/agent/plan';
import { answerWhatIf, type WhatIfResult } from '../../src/agent/whatIf';
import type { LlmClient } from '../../src/agent/llm';
import { WHATIF_CAFE, WHATIF_CASES, type Expected, type WhatIfCase } from './cases';

const SIM = { reps: 80, seed: 99 };

const key = (c: Record<string, unknown>, onlyKind: boolean) =>
  onlyKind ? String(c.kind) : JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'any').sort(([a], [b]) => a.localeCompare(b))));

/** Same changes, in any order (for `any`, only the kind). */
export function changesMatch(expected: Expected[], got: Change[]): boolean {
  if (expected.length !== got.length) return false;
  const left = got.map((g) => g as unknown as Record<string, unknown>);
  for (const e of expected) {
    const i = left.findIndex((g) => key(g, !!e.any) === key(e, !!e.any));
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

export function scoreCase(c: WhatIfCase, r: WhatIfResult): { pass: boolean; why: string } {
  if (!r.ok) return { pass: false, why: `no answer: ${r.answer.slice(0, 90)}` };
  if (/could not turn/i.test(r.answer)) return { pass: false, why: 'generic error text' };
  if (!changesMatch(c.expected, r.changes)) return { pass: false, why: `read as ${JSON.stringify(r.changes)}` };
  if (c.breaks) {
    if (!r.limits?.breaks.some((b) => b.key === c.breaks)) return { pass: false, why: 'did not name the broken limit' };
    const s = r.limits.suggestion;
    if (!s) return { pass: false, why: 'no nearest allowed change' };
    if (validatePlan(WHATIF_CAFE, s.changes).length || constraintBreaks(WHATIF_CAFE, s.changes, c.constraints ?? {}, DEFAULT_COSTS).length)
      return { pass: false, why: 'suggestion breaks a rule or limit' };
  }
  return { pass: true, why: r.readBy === 'rules' ? 'read by rules' : 'read by AI' };
}

async function runAll(label: string, llm: LlmClient | null) {
  const rows = [];
  for (const c of WHATIF_CASES) {
    const r = await answerWhatIf(WHATIF_CAFE, c.question, llm, SIM, { constraints: c.constraints ?? {}, costs: DEFAULT_COSTS });
    const s = scoreCase(c, r);
    rows.push({ id: c.id, question: c.question, ...s, readBy: r.readBy, changes: r.changes, limits: r.limits ? { breaks: r.limits.breaks, suggestion: r.limits.suggestion?.changes ?? null } : null, answer: r.answer, llmCalls: r.llmCalls });
    console.log(`[whatif:${label}] ${c.id} ${s.pass ? 'PASS' : 'FAIL'} — ${c.question} — ${s.why}`);
  }
  const passed = rows.filter((x) => x.pass).length;
  console.log(`[whatif:${label}] ${passed} of ${rows.length} passed`);
  mkdirSync('eval/results-whatif', { recursive: true });
  writeFileSync(`eval/results-whatif/${label}.json`, JSON.stringify({ passed, of: rows.length, rows }, null, 2) + '\n');
  return passed;
}

await runAll('rules', null);
if (process.argv.includes('--live')) {
  const k = await loadEnvKey('OPENROUTER_API_KEY');
  if (!k) throw new Error('OPENROUTER_API_KEY not found');
  const llm = new OpenRouterLlm({ apiKey: k, reasoningEffort: 'low' });
  await runAll('ai', llm);
  console.log(`[whatif] OpenRouter reported cost $${llm.costUsd.toFixed(4)}`);
}
