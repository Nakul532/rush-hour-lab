// Web Worker: all simulation (and the AI analyst's loop, whose LLM calls go
// to /api/llm) runs here so the page stays responsive. Costs nothing to host.
import { recommend, VERIFY_SIM, type HybridResult } from '../src/agent/hybrid';
import { simulate, type ResultSummary } from '../src/agent/evaluate';
import { answerWhatIf, type WhatIfResult } from '../src/agent/whatIf';
import { buildModelFromDescription, type BuildResult } from '../src/agent/modelBuilder';
import { applyChanges } from '../src/agent/changes';
import type { CafeSpec } from '../src/sim/cafe';
import type { Constraints, CostTable } from '../src/agent/plan';
import { HttpLlm } from './httpLlm';

export type WorkerRequest =
  | { id: number; type: 'recommend'; spec: CafeSpec; constraints: Constraints; costs: CostTable; useLlm: boolean; analysisId: string }
  | { id: number; type: 'whatIf'; spec: CafeSpec; question: string; analysisId: string }
  | { id: number; type: 'build'; description: string; analysisId: string };

export type WorkerResponse =
  | { id: number; type: 'progress'; phase: string; done: number; total: number }
  | { id: number; type: 'recommend'; result: HybridResult; before: ResultSummary; after: ResultSummary | null }
  | { id: number; type: 'whatIf'; result: WhatIfResult }
  | { id: number; type: 'build'; result: BuildResult }
  | { id: number; type: 'error'; message: string };

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);
// Same replications and seed as the final re-check, so the table matches the headline.
const REPORT_SIM = VERIFY_SIM;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'recommend') {
      const result = await recommend(m.spec, {
        constraints: m.constraints,
        costs: m.costs,
        llm: m.useLlm ? new HttpLlm(m.analysisId) : undefined,
        onProgress: (p) => post({ id: m.id, type: 'progress', ...p }),
      });
      post({ id: m.id, type: 'progress', phase: 'Measuring before and after', done: 0, total: 1 });
      const before = simulate(m.spec, REPORT_SIM).summary;
      const after = result.recommended ? simulate(applyChanges(m.spec, result.recommended.record.changes), REPORT_SIM).summary : null;
      post({ id: m.id, type: 'recommend', result, before, after });
    } else if (m.type === 'whatIf') {
      post({ id: m.id, type: 'whatIf', result: await answerWhatIf(m.spec, m.question, new HttpLlm(m.analysisId)) });
    } else if (m.type === 'build') {
      post({ id: m.id, type: 'build', result: await buildModelFromDescription(m.description, new HttpLlm(m.analysisId)) });
    }
  } catch (err) {
    post({ id: m.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
