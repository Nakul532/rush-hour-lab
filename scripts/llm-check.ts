// npm run llm-check
// Confirms the OpenRouter key loads (prints its name only), shows credits,
// and makes one tiny call pinned to Groq.

import { loadEnvKey, OpenRouterLlm } from '../src/agent/openrouter';

const key = await loadEnvKey('OPENROUTER_API_KEY');
if (!key) {
  console.log('OPENROUTER_API_KEY not found in the environment, .env.local or .env');
  process.exit(1);
}
console.log('Loaded OPENROUTER_API_KEY');
const llm = new OpenRouterLlm({ apiKey: key });
const before = await llm.credits();
console.log(`Credits used so far: $${before.usage.toFixed(4)}; limit ${before.limit === null ? 'none' : `$${before.limit}`}; remaining ${before.remaining === null ? 'n/a' : `$${before.remaining.toFixed(4)}`}`);
const res = await llm.complete({ messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 64 });
console.log(`Reply: ${JSON.stringify(res.message.content)} | model ${res.model} | provider ${res.provider} | ${res.usage.totalTokens} tokens | cost $${res.costUsd.toFixed(6)}`);
