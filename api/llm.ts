// Vercel serverless function: the only place the OpenRouter key is used.
// POST /api/llm  { messages, tools?, toolChoice?, maxTokens? }  →  LlmResponse
//
// Limits (all return a friendly JSON message with status 429, never an error page):
// - at most 15 LLM calls per analysis (X-Analysis-Id header)
// - at most PER_IP_DAILY calls per visitor per day
// - at most SITE_DAILY calls per day site-wide
// Counters live in memory, so they reset when an instance is recycled; they
// are a soft guard. The hard guard is the OpenRouter key's own credit limit.
//
// Model and provider are fixed here, not taken from the request.

import { OpenRouterLlm } from '../src/agent/openrouter';
import type { LlmRequest } from '../src/agent/llm';

export const config = { runtime: 'edge' };

const PER_ANALYSIS = 15;
const PER_IP_DAILY = 80;
const SITE_DAILY = Number(globalThis.process?.env?.SITE_DAILY_LLM_CALLS ?? 1500);
const MAX_MESSAGES = 60;
const MAX_BODY_CHARS = 120_000;

type Counts = { day: string; site: number; ip: Map<string, number>; analysis: Map<string, number> };
const g = globalThis as unknown as { __rushHourCounts?: Counts };
function counts(): Counts {
  const day = new Date().toISOString().slice(0, 10);
  if (!g.__rushHourCounts || g.__rushHourCounts.day !== day) g.__rushHourCounts = { day, site: 0, ip: new Map(), analysis: new Map() };
  return g.__rushHourCounts;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const limit = (message: string) => json({ limit: true, message }, 429);

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const key = globalThis.process?.env?.OPENROUTER_API_KEY;
  if (!key || globalThis.process?.env?.LLM_MODE === 'off') return json({ disabled: true, message: 'The AI analyst is switched off right now. The simulation still works.' }, 503);

  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return json({ error: 'Request too large' }, 413);
  let body: LlmRequest;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) return json({ error: 'Invalid messages' }, 400);
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 8)) return json({ error: 'Invalid tools' }, 400);

  const c = counts();
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const analysisId = (req.headers.get('x-analysis-id') ?? '').slice(0, 64) || `ip:${ip}`;
  if (c.site >= SITE_DAILY) return limit("Today's limit for the AI analyst has been reached. The simulation still works; please try the AI features again tomorrow.");
  if ((c.ip.get(ip) ?? 0) >= PER_IP_DAILY) return limit("You've reached today's limit for the AI analyst. The simulation still works; please try again tomorrow.");
  if ((c.analysis.get(analysisId) ?? 0) >= PER_ANALYSIS) return limit('This analysis has used its 15 AI calls. Start a new analysis to ask more.');
  c.site++;
  c.ip.set(ip, (c.ip.get(ip) ?? 0) + 1);
  c.analysis.set(analysisId, (c.analysis.get(analysisId) ?? 0) + 1);

  try {
    const llm = new OpenRouterLlm({ apiKey: key, reasoningEffort: 'low', retryDelaysMs: [1500, 3000] });
    const res = await llm.complete({
      messages: body.messages,
      tools: body.tools,
      toolChoice: body.toolChoice === 'required' ? 'required' : 'auto',
      maxTokens: Math.min(Math.max(64, Number(body.maxTokens) || 1024), 1024),
    });
    return json({ message: res.message, usage: res.usage, model: res.model });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 402) return limit('The AI analyst has used its credit for now. The simulation still works.');
    if (status === 429) return limit('The AI analyst is busy right now. Please try again in a minute.');
    return json({ error: 'The AI analyst could not answer right now.' }, 502);
  }
}
