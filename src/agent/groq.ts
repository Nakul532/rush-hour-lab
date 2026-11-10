// Groq client (OpenAI-compatible API, gpt-oss-120b). Used only when
// LLM_MODE=groq; tests inject a fake fetch and never reach the network.
// The API key is passed in by the caller and never logged.

import type { LlmClient, LlmRequest, LlmResponse, ToolCall } from './llm';

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_MODEL = 'openai/gpt-oss-120b';

export class LlmHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface GroqOptions {
  apiKey: string;
  model?: string;
  /** gpt-oss reasoning effort; "low" keeps token use down. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  fetchImpl?: typeof fetch;
}

export class GroqLlm implements LlmClient {
  constructor(private readonly opts: GroqOptions) {
    if (!opts.apiKey) throw new Error('GroqLlm needs an API key');
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: this.opts.model ?? GROQ_MODEL,
      messages: req.messages,
      ...(req.tools ? { tools: req.tools, tool_choice: req.toolChoice ?? 'auto' } : {}),
      max_completion_tokens: req.maxTokens ?? 1024,
      reasoning_effort: this.opts.reasoningEffort ?? 'low',
      temperature: 0,
    };
    const res = await (this.opts.fetchImpl ?? fetch)(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new LlmHttpError(res.status, `Groq returned ${res.status}: ${text}`);
    }
    const json = (await res.json()) as {
      model: string;
      choices: Array<{ message: { content: string | null; tool_calls?: ToolCall[] } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const m = json.choices[0]?.message ?? { content: null };
    const usage = json.usage ?? {};
    return {
      message: { role: 'assistant', content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) },
      usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      },
      model: json.model,
    };
  }
}
