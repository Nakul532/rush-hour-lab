// LLM plumbing: limits and the Groq client (with a fake fetch; no network).
import { describe, expect, it } from 'vitest';
import { GROQ_MODEL, GROQ_URL, GroqLlm, LlmHttpError } from '../../src/agent/groq';
import { LimitedLlm, LlmLimitError, MockLlm, RecordingLlm, TokenBudget } from '../../src/agent/llm';

describe('token budget and call cap', () => {
  it('refuses before a call would start with too few tokens left, never after', async () => {
    const budget = new TokenBudget(100);
    const llm = new LimitedLlm(new MockLlm([{ content: 'ok' }], true), { budget, reserveTokens: 60 });
    await llm.complete({ messages: [{ role: 'user', content: 'x'.repeat(100) }] });
    expect(budget.used).toBeGreaterThan(0);
    await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ limit: 'tokens' });
  });

  it('one budget can be shared across several analyses', async () => {
    const budget = new TokenBudget(1000);
    const a = new LimitedLlm(new MockLlm([{ content: 'a' }], true), { budget });
    const b = new LimitedLlm(new MockLlm([{ content: 'b' }], true), { budget });
    await a.complete({ messages: [{ role: 'user', content: 'x'.repeat(400) }] });
    await b.complete({ messages: [{ role: 'user', content: 'x'.repeat(400) }] });
    expect(budget.used).toBe(a.tokens + b.tokens);
  });

  it('call cap', async () => {
    const llm = new LimitedLlm(new MockLlm([{ content: 'ok' }], true), { maxCalls: 2 });
    await llm.complete({ messages: [] });
    await llm.complete({ messages: [] });
    await expect(llm.complete({ messages: [] })).rejects.toBeInstanceOf(LlmLimitError);
  });

  it('recording keeps request/response pairs for fixtures', async () => {
    const rec = new RecordingLlm(new MockLlm([{ content: 'hi' }]));
    await rec.complete({ messages: [{ role: 'user', content: 'q' }] });
    expect(rec.log[0].response.message.content).toBe('hi');
  });
});

describe('Groq client (fake fetch)', () => {
  const okFetch = (capture: { url?: string; init?: RequestInit }) =>
    (async (url: string, init: RequestInit) => {
      capture.url = url;
      capture.init = init;
      return new Response(
        JSON.stringify({
          model: GROQ_MODEL,
          choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'finish', arguments: '{"summary":"ok"}' } }] } }],
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

  it('sends an OpenAI-compatible request to gpt-oss-120b with low reasoning effort', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const llm = new GroqLlm({ apiKey: 'test-key', fetchImpl: okFetch(cap) });
    const res = await llm.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 200 });
    expect(cap.url).toBe(GROQ_URL);
    const body = JSON.parse(cap.init!.body as string);
    expect(body).toMatchObject({ model: 'openai/gpt-oss-120b', reasoning_effort: 'low', max_completion_tokens: 200, temperature: 0 });
    expect((cap.init!.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(res.usage.totalTokens).toBe(150);
    expect(res.message.tool_calls![0].function.name).toBe('finish');
  });

  it('turns HTTP errors (e.g. 429 rate limit) into typed errors', async () => {
    const llm = new GroqLlm({ apiKey: 'k', fetchImpl: (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch });
    await expect(llm.complete({ messages: [] })).rejects.toMatchObject({ status: 429 });
    await expect(llm.complete({ messages: [] })).rejects.toBeInstanceOf(LlmHttpError);
  });

  it('refuses to start without a key', () => {
    expect(() => new GroqLlm({ apiKey: '' })).toThrow();
  });
});
