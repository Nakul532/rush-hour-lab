// LLM plumbing in the OpenAI-compatible chat + tool-calling format (what Groq
// serves). The agent only sees the LlmClient interface, so tests use
// MockLlm and never touch the network.

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'required';
  maxTokens?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
  usage: Usage;
  model: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmLimitError extends Error {
  constructor(public readonly limit: 'calls' | 'tokens', message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- mock

export interface MockTurn {
  content?: string;
  /** args may be an object (serialized for you) or a raw string, to test malformed JSON. */
  toolCalls?: Array<{ name: string; args: unknown }>;
}
export type MockStep = MockTurn | ((req: LlmRequest, callIndex: number) => MockTurn);

export class MockExhaustedError extends Error {}

const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** Plays back a script of responses. Records every request it receives. */
export class MockLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly script: MockStep[], private readonly repeatLast = false) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const idx = this.i++;
    const step = this.script[Math.min(idx, this.script.length - 1)];
    if (step === undefined || (idx >= this.script.length && !this.repeatLast)) throw new MockExhaustedError(`Mock script ran out at call ${idx + 1}`);
    const turn = typeof step === 'function' ? step(req, idx) : step;
    const tool_calls = turn.toolCalls?.map((t, k) => ({
      id: `call_${idx}_${k}`,
      type: 'function' as const,
      function: { name: t.name, arguments: typeof t.args === 'string' ? t.args : JSON.stringify(t.args) },
    }));
    const message = { role: 'assistant' as const, content: turn.content ?? null, ...(tool_calls ? { tool_calls } : {}) };
    const promptTokens = estimateTokens(JSON.stringify(req.messages) + JSON.stringify(req.tools ?? []));
    const completionTokens = estimateTokens(JSON.stringify(message));
    return { message, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }, model: 'mock' };
  }
}

// ---------------------------------------------------------------- limits

/** Shared token budget, e.g. 40K tokens across a whole live test session. */
export class TokenBudget {
  used = 0;
  constructor(public readonly maxTokens: number) {}
  get remaining(): number {
    return this.maxTokens - this.used;
  }
}

export interface LimitOptions {
  maxCalls?: number;
  budget?: TokenBudget;
  /** Refuse a call unless at least this many tokens remain (worst case for one call). */
  reserveTokens?: number;
  /**
   * Instead of a fixed reserve, estimate each call's worst case from its size:
   * prompt (characters ÷ 3, a deliberately high estimate) + its max completion tokens.
   */
  estimatePerCall?: boolean;
}

/** High estimate of one call's total tokens: prompt chars ÷ 3 + max completion tokens. */
export function worstCaseTokens(req: LlmRequest): number {
  return Math.ceil((JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length) / 3) + (req.maxTokens ?? 1024);
}

/** Wraps a client with a call cap and a token budget. Refuses before spending, never after. */
export class LimitedLlm implements LlmClient {
  calls = 0;
  tokens = 0;
  constructor(private readonly inner: LlmClient, private readonly opts: LimitOptions) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { maxCalls, budget, estimatePerCall } = this.opts;
    const reserveTokens = estimatePerCall ? worstCaseTokens(req) : (this.opts.reserveTokens ?? 0);
    if (maxCalls !== undefined && this.calls >= maxCalls) throw new LlmLimitError('calls', `LLM call limit of ${maxCalls} reached`);
    if (budget && budget.remaining < reserveTokens)
      throw new LlmLimitError('tokens', `Token budget nearly used: ${budget.remaining} of ${budget.maxTokens} left, need ${reserveTokens}`);
    this.calls++;
    const res = await this.inner.complete(req);
    this.tokens += res.usage.totalTokens;
    if (budget) budget.used += res.usage.totalTokens;
    return res;
  }
}

/** Keeps every request/response pair, to save live runs as test fixtures. */
export class RecordingLlm implements LlmClient {
  readonly log: Array<{ request: LlmRequest; response: LlmResponse }> = [];
  constructor(private readonly inner: LlmClient) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const response = await this.inner.complete(req);
    this.log.push({ request: structuredClone(req), response });
    return response;
  }
}
