// The experiment loop. The LLM proposes; code checks, simulates and decides.
//
// Each LLM turn calls one tool. Code validates the arguments, runs the
// simulation, and sends back a compact result. test_change runs the full
// acceptance rule and records an experiment. The loop stops when the LLM
// calls finish, or at the experiment budget, the LLM call cap (15) or the
// token budget, whichever comes first.

import type { CafeSpec } from '../sim/cafe';
import { applyChanges, ChangeError, describeChange, parseChanges, type Change } from './changes';
import { compare, decide, DEFAULT_SIM, findBottleneck, sensitivity, simulate, type Bottleneck, type Comparison, type Decision, type Evidence, type ResultSummary, type SimSettings } from './evaluate';
import { LlmLimitError, type ChatMessage, type LlmClient, type ToolCall } from './llm';
import { DEFAULT_COSTS, constraintViolations, planCost, type Constraints, type CostTable } from './plan';
import { AGENT_TOOLS, agentSystemPrompt, describeCafe, describeConstraints, r1 } from './prompts';

export const MAX_LLM_CALLS = 15;

export interface ExperimentRecord {
  id: number;
  /** The LLM's hypothesis. A guess, not a result. */
  hypothesis: string;
  changes: Change[];
  descriptions: string[];
  /** First-month cost using the cost table (defaults are ASSUMPTIONS). */
  costUsd: number;
  /** Constraints the plan broke. A blocked plan is not simulated. */
  violations: string[];
  status: 'accepted' | 'rejected' | 'blocked';
  decision?: Decision;
  evidence?: Evidence;
}

export type AgentStep =
  | { kind: 'tool'; tool: string; summary: string }
  | { kind: 'experiment'; experiment: ExperimentRecord }
  | { kind: 'error'; message: string }
  | { kind: 'stop'; reason: StopReason; message: string };

export type StopReason = 'finished' | 'experiment_budget' | 'llm_call_limit' | 'token_budget' | 'llm_error' | 'no_tool_call';

export interface AnalysisOptions {
  constraints?: Constraints;
  costs?: CostTable;
  sim?: SimSettings;
  maxExperiments?: number;
  maxLlmCalls?: number;
  /** Most run_simulation/find_bottleneck/compare/sensitivity calls (keeps CPU bounded). */
  maxSimulations?: number;
  /** Max completion tokens per LLM call. */
  maxTokensPerCall?: number;
}

export interface AnalysisResult {
  baseline: ResultSummary;
  bottleneck: Bottleneck;
  experiments: ExperimentRecord[];
  /** Best accepted plan by p90 improvement (cheaper wins ties), or null. */
  recommended: ExperimentRecord | null;
  steps: AgentStep[];
  stopReason: StopReason;
  /** The LLM's closing summary; null if it had numbers in it (the app shows numbers from code only). */
  summary: string | null;
  llmCalls: number;
  tokens: number;
}

/** LLM text shown to users must not carry numbers: those come from code. */
export function numberFree(text: unknown): string | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  return /\d/.test(text) ? null : text.trim();
}

function compactSummary(s: ResultSummary) {
  const byType: Record<string, unknown> = {};
  for (const [t, v] of Object.entries(s.byType)) byType[t] = { p90: r1(v!.p90.mean), median: r1(v!.median.mean) };
  const util: Record<string, unknown> = {};
  for (const [id, st] of Object.entries(s.stations)) util[id] = st.utilization === null ? 'batch' : { busy: r1(st.utilization * 100), maxQueue: r1(st.maxQueue) };
  return { p90: r1(s.overall.p90.mean), median: r1(s.overall.median.mean), byType, stations: util };
}

function compactComparison(c: Comparison) {
  const byType: Record<string, unknown> = {};
  for (const [t, v] of Object.entries(c.byType)) byType[t] = [r1(v!.baseP90), r1(v!.candidateP90)];
  return { p90: [r1(c.baseP90), r1(c.candidateP90)], improvementPct: r1(c.improvement * 100), ci: [r1(c.diff.low), r1(c.diff.high)], byTypeP90: byType };
}

function compactExperiment(e: ExperimentRecord) {
  if (e.status === 'blocked') return { experiment: e.id, status: 'blocked', violations: e.violations };
  return {
    experiment: e.id,
    status: e.status,
    costUsd: Math.round(e.costUsd),
    failed: e.decision!.checks.filter((c) => !c.passed).map((c) => c.name),
    nominal: compactComparison(e.evidence!.nominal),
    faster30: [r1(e.evidence!.faster.baseP90), r1(e.evidence!.faster.candidateP90)],
    slower30: [r1(e.evidence!.slower.baseP90), r1(e.evidence!.slower.candidateP90)],
  };
}

export function pickRecommended(experiments: ExperimentRecord[]): ExperimentRecord | null {
  const ok = experiments.filter((e) => e.status === 'accepted');
  ok.sort((a, b) => b.evidence!.nominal.improvement - a.evidence!.nominal.improvement || a.costUsd - b.costUsd);
  return ok[0] ?? null;
}

/** Run one experiment: constraints first, then the acceptance rule. */
export function runExperiment(
  id: number, base: CafeSpec, hypothesis: string, changes: Change[], constraints: Constraints, costs: CostTable, sim: SimSettings,
): ExperimentRecord {
  const violations = constraintViolations(base, changes, constraints, costs);
  const record: ExperimentRecord = {
    id, hypothesis, changes,
    descriptions: changes.map((c) => describeChange(c, base.startsAt)),
    costUsd: planCost(base, changes, costs),
    violations,
    status: 'blocked',
  };
  if (violations.length > 0) return record;
  const evidence = sensitivity(base, applyChanges(base, changes), sim);
  const decision = decide(evidence);
  return { ...record, evidence, decision, status: decision.accepted ? 'accepted' : 'rejected' };
}

export async function runAnalysis(base: CafeSpec, llm: LlmClient, opts: AnalysisOptions = {}): Promise<AnalysisResult> {
  const constraints = opts.constraints ?? {};
  const costs = opts.costs ?? DEFAULT_COSTS;
  const sim = opts.sim ?? DEFAULT_SIM;
  const maxExperiments = opts.maxExperiments ?? 6;
  const maxCalls = Math.min(opts.maxLlmCalls ?? MAX_LLM_CALLS, MAX_LLM_CALLS);
  const maxSimulations = opts.maxSimulations ?? 12;

  const baseline = simulate(base, sim).summary;
  const bottleneck = findBottleneck(baseline);
  const steps: AgentStep[] = [];
  const experiments: ExperimentRecord[] = [];
  let llmCalls = 0;
  let tokens = 0;
  let simulations = 0;
  let summary: string | null = null;
  let stopReason: StopReason | null = null;
  let silentTurns = 0;

  const messages: ChatMessage[] = [
    { role: 'system', content: agentSystemPrompt(maxExperiments, maxCalls) },
    {
      role: 'user',
      content: [
        describeCafe(base),
        describeConstraints(constraints, costs),
        `Today (simulated): ${JSON.stringify(compactSummary(baseline))}`,
        `Busiest station: ${bottleneck.station} (${r1(bottleneck.utilization * 100)}% busy).`,
      ].join('\n'),
    },
  ];

  const changesArg = (raw: unknown, spec: CafeSpec) => parseChanges(raw ?? [], spec);

  const execute = (call: ToolCall): unknown => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || '{}');
      if (typeof args !== 'object' || args === null) throw new Error();
    } catch {
      throw new ChangeError(`Arguments for ${call.function.name} were not valid JSON`);
    }
    const name = call.function.name;
    const needsSim = ['run_simulation', 'find_bottleneck', 'compare', 'sensitivity'].includes(name);
    if (needsSim && simulations >= maxSimulations) throw new ChangeError(`Simulation limit (${maxSimulations}) reached; use test_change or finish`);
    switch (name) {
      case 'run_simulation': {
        simulations++;
        const s = simulate(applyChanges(base, changesArg(args.changes, base)), sim).summary;
        steps.push({ kind: 'tool', tool: name, summary: `Simulated a plan: overall p90 ${r1(s.overall.p90.mean)} min` });
        return compactSummary(s);
      }
      case 'find_bottleneck': {
        simulations++;
        const b = findBottleneck(simulate(applyChanges(base, changesArg(args.changes, base)), sim).summary);
        steps.push({ kind: 'tool', tool: name, summary: `Busiest station: ${b.station} (${r1(b.utilization * 100)}% busy)` });
        return { station: b.station, ranking: b.ranking.map((r) => ({ station: r.station, busy: r1(r.utilization * 100), maxQueue: r1(r.maxQueue) })) };
      }
      case 'compare': {
        simulations++;
        const a = changesArg(args.changes_a, base);
        const b = changesArg(args.changes_b, base);
        const c = compare(applyChanges(base, a), applyChanges(base, b), sim);
        steps.push({ kind: 'tool', tool: name, summary: `Compared two plans: p90 ${r1(c.baseP90)} vs ${r1(c.candidateP90)} min` });
        return compactComparison(c);
      }
      case 'sensitivity': {
        simulations++;
        const e = sensitivity(base, applyChanges(base, changesArg(args.changes, base)), sim);
        steps.push({ kind: 'tool', tool: name, summary: 'Checked a plan with task times ±30%' });
        return { nominal: compactComparison(e.nominal), faster30: compactComparison(e.faster), slower30: compactComparison(e.slower) };
      }
      case 'test_change': {
        if (experiments.length >= maxExperiments) throw new ChangeError('Experiment budget used up; call finish');
        const changes = changesArg(args.changes, base);
        if (changes.length === 0) throw new ChangeError('test_change needs at least one change');
        const hypothesis = typeof args.hypothesis === 'string' ? args.hypothesis.slice(0, 300) : '';
        const e = runExperiment(experiments.length + 1, base, hypothesis, changes, constraints, costs, sim);
        experiments.push(e);
        steps.push({ kind: 'experiment', experiment: e });
        return compactExperiment(e);
      }
      case 'finish':
        summary = numberFree(args.summary);
        stopReason = 'finished';
        return { ok: true };
      default:
        throw new ChangeError(`Unknown tool "${name}". Tools: ${AGENT_TOOLS.map((t) => t.function.name).join(', ')}`);
    }
  };

  while (stopReason === null) {
    if (experiments.length >= maxExperiments) {
      stopReason = 'experiment_budget';
      break;
    }
    if (llmCalls >= maxCalls) {
      stopReason = 'llm_call_limit';
      break;
    }
    let res;
    try {
      res = await llm.complete({ messages, tools: AGENT_TOOLS, toolChoice: 'required', maxTokens: opts.maxTokensPerCall ?? 1024 });
    } catch (err) {
      if (err instanceof LlmLimitError) stopReason = err.limit === 'calls' ? 'llm_call_limit' : 'token_budget';
      else stopReason = 'llm_error';
      steps.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      break;
    }
    llmCalls++;
    tokens += res.usage.totalTokens;
    messages.push(res.message);
    const calls = res.message.tool_calls ?? [];
    if (calls.length === 0) {
      silentTurns++;
      steps.push({ kind: 'error', message: 'The model replied without calling a tool' });
      if (silentTurns >= 2) {
        stopReason = 'no_tool_call';
        break;
      }
      messages.push({ role: 'user', content: 'Call one tool. Use finish if you are done.' });
      continue;
    }
    silentTurns = 0;
    // One tool per turn: answer extra calls with an error so the history stays valid.
    calls.forEach((call, k) => {
      let content: unknown;
      if (k > 0) content = { error: 'Only one tool call per turn; this one was ignored' };
      else {
        try {
          content = execute(call);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          steps.push({ kind: 'error', message });
          content = { error: message };
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(content) });
    });
  }

  const final = stopReason as StopReason;
  const stopMessages: Record<StopReason, string> = {
    finished: 'The agent finished.',
    experiment_budget: `Stopped at the experiment budget (${maxExperiments}).`,
    llm_call_limit: `Stopped at the LLM call limit (${maxCalls}).`,
    token_budget: 'Stopped: the token budget is nearly used up.',
    llm_error: 'Stopped: the language model returned an error.',
    no_tool_call: 'Stopped: the model kept replying without calling a tool.',
  };
  steps.push({ kind: 'stop', reason: final, message: stopMessages[final] });
  return { baseline, bottleneck, experiments, recommended: pickRecommended(experiments), steps, stopReason: final, summary, llmCalls, tokens };
}
