// OpenRouter client (OpenAI-compatible), gpt-oss-120b pinned to the Groq
// provider with fallbacks disabled: if Groq can't serve the request, the
// call fails instead of silently going to another provider.
// The key is passed in by the caller and never logged.

import { LlmHttpError } from './groq';
import type { LlmClient, LlmRequest, LlmResponse, ToolCall } from './llm';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_MODEL = 'openai/gpt-oss-120b';
export const PINNED_PROVIDER = 'Groq';

export interface OpenRouterOptions {
  apiKey: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  fetchImpl?: typeof fetch;
}

export interface OpenRouterResponse extends LlmResponse {
  provider: string;
  /** Cost of this call in USD credits, as reported by OpenRouter. */
  costUsd: number;
}

export class OpenRouterLlm implements LlmClient {
  /** Total USD credits reported across calls made by this client. */
  costUsd = 0;
  constructor(private readonly opts: OpenRouterOptions) {
    if (!opts.apiKey) throw new Error('OpenRouterLlm needs an API key');
  }

  private get fetch() {
    return this.opts.fetchImpl ?? fetch;
  }

  async complete(req: LlmRequest): Promise<OpenRouterResponse> {
    const body = {
      model: this.opts.model ?? OPENROUTER_MODEL,
      messages: req.messages,
      ...(req.tools ? { tools: req.tools, tool_choice: req.toolChoice ?? 'auto' } : {}),
      max_tokens: req.maxTokens ?? 1024,
      temperature: 0,
      reasoning: { effort: this.opts.reasoningEffort ?? 'low' },
      provider: { order: [PINNED_PROVIDER], allow_fallbacks: false },
      usage: { include: true },
    };
    const res = await this.fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}`, 'X-Title': 'Rush Hour Lab' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new LlmHttpError(res.status, `OpenRouter returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      model: string;
      provider?: string;
      error?: { message?: string };
      choices?: Array<{ message: { content: string | null; tool_calls?: ToolCall[] } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
    };
    if (json.error || !json.choices) throw new LlmHttpError(502, `OpenRouter error: ${json.error?.message ?? 'no choices returned'}`);
    if (json.provider && json.provider !== PINNED_PROVIDER) throw new LlmHttpError(502, `Served by ${json.provider}, not ${PINNED_PROVIDER}`);
    const m = json.choices[0]?.message ?? { content: null };
    const u = json.usage ?? {};
    const costUsd = u.cost ?? 0;
    this.costUsd += costUsd;
    return {
      message: { role: 'assistant', content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) },
      usage: {
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
      },
      model: json.model,
      provider: json.provider ?? 'unknown',
      costUsd,
    };
  }

  /** Credits used and the key's limit, in USD. */
  async credits(): Promise<{ usage: number; limit: number | null; remaining: number | null }> {
    const res = await this.fetch(`${OPENROUTER_BASE}/key`, { headers: { Authorization: `Bearer ${this.opts.apiKey}` } });
    if (!res.ok) throw new LlmHttpError(res.status, `OpenRouter /key returned ${res.status}`);
    const { data } = (await res.json()) as { data: { usage: number; limit: number | null; limit_remaining?: number | null } };
    return { usage: data.usage, limit: data.limit, remaining: data.limit_remaining ?? (data.limit === null ? null : data.limit - data.usage) };
  }
}

/** Read a key from the environment, or from .env / .env.local (KEY=value lines). Never printed. */
export async function loadEnvKey(name: string): Promise<string | null> {
  if (process.env[name]) return process.env[name] as string;
  const { existsSync, readFileSync } = await import('node:fs');
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*"?([^"\\s]+)"?\\s*$`));
      if (m) return m[1];
    }
  }
  return null;
}
