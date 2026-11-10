/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Dev only: serve /api/llm with the same handler Vercel runs, using the key from .env. */
function localApi(mode: string): Plugin {
  return {
    name: 'local-api',
    configureServer(server) {
      const env = loadEnv(mode, process.cwd(), '');
      for (const k of ['OPENROUTER_API_KEY', 'LLM_MODE', 'SITE_DAILY_LLM_CALLS']) if (env[k] && !process.env[k]) process.env[k] = env[k];
      server.middlewares.use('/api/llm', async (req, res) => {
        const { default: handler } = await server.ssrLoadModule('/api/llm.ts');
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const out: Response = await handler(new Request('http://localhost/api/llm', { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }));
        res.statusCode = out.status;
        out.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(await out.text());
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), localApi(mode)],
  worker: { format: 'es' },
  build: { outDir: 'dist', target: 'es2022' },
  // Simulation-heavy tests (brute-force search) need more than the 5 s default.
  test: { testTimeout: 120_000 },
}));
