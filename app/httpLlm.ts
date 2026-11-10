// Browser-side LLM client: posts to our /api/llm function (the key never
// reaches the browser). Limit replies become LlmLimitError so the UI shows a
// friendly message.
import { LlmLimitError, type LlmClient, type LlmRequest, type LlmResponse } from '../src/agent/llm';

export class LlmUnavailableError extends Error {}

export class HttpLlm implements LlmClient {
  calls = 0;
  constructor(private readonly analysisId: string, private readonly url = '/api/llm') {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Analysis-Id': this.analysisId },
      body: JSON.stringify(req),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 429 && body.limit) throw new LlmLimitError('calls', body.message);
    if (res.status === 503 && body.disabled) throw new LlmUnavailableError(body.message);
    if (!res.ok) throw new LlmUnavailableError(body.error ?? 'The AI analyst could not answer right now.');
    return body as LlmResponse;
  }
}
