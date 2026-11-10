// Rule-based baseline agent (no LLM): always work on the current bottleneck.
// Used as a reference in tests and in the Stage 3 evaluation, next to brute force.

import type { CafeSpec } from '../sim/cafe';
import { applyChanges, simplifyChanges, type Change, type StationName } from './changes';
import { type AnalysisResult, type AgentStep, type ExperimentRecord, pickRecommended, runExperiment } from './agent';
import { DEFAULT_SIM, findBottleneck, simulate, type SimSettings } from './evaluate';
import { DEFAULT_COSTS, type Constraints, type CostTable } from './plan';

/** Extra improvement (share of today's p90) a further change must add. */
export const MIN_MARGINAL_GAIN = 0.05;

function candidates(spec: CafeSpec, constraints: Constraints, sim: SimSettings): Change[][] {
  const b = findBottleneck(simulate(spec, sim).summary);
  const station = b.station as StationName;
  const out: Change[][] = [];
  if (constraints.noNewHires) {
    // Move one person from the least busy station that has more than one.
    const donor = [...b.ranking].reverse().find((r) => r.station !== station && staffAt0(spec, r.station as StationName) > 1);
    if (donor) out.push([{ kind: 'staff', station: donor.station as StationName, delta: -1 }, { kind: 'staff', station, delta: 1 }]);
  } else {
    out.push([{ kind: 'staff', station, delta: 1 }]);
  }
  if (station === 'kitchen' && spec.prepMode === 'sequential') out.push([{ kind: 'prepMode', mode: 'parallel' }]);
  if (station === 'barista') {
    out.push([{ kind: 'grabGo', shareOfDrinks: 0.3 }]);
    if (spec.handoff !== 'dedicated' && !constraints.noNewHires) out.push([{ kind: 'dedicatedHandoff', staff: 1 }]);
  }
  return out;
}

function staffAt0(spec: CafeSpec, station: StationName): number {
  const s = spec.staff[station];
  if (s === undefined) return 0;
  return typeof s === 'number' ? s : s[0].servers;
}

export function runHeuristic(base: CafeSpec, opts: { constraints?: Constraints; costs?: CostTable; sim?: SimSettings; maxExperiments?: number } = {}): AnalysisResult {
  const constraints = opts.constraints ?? {};
  const costs = opts.costs ?? DEFAULT_COSTS;
  const sim = opts.sim ?? DEFAULT_SIM;
  const maxExperiments = opts.maxExperiments ?? 6;
  const baseline = simulate(base, sim).summary;
  const experiments: ExperimentRecord[] = [];
  const steps: AgentStep[] = [];
  let plan: Change[] = [];
  let bestImprovement = 0;

  outer: while (experiments.length < maxExperiments) {
    const options = candidates(applyChanges(base, plan), constraints, sim);
    let improved = false;
    for (const extra of options) {
      if (experiments.length >= maxExperiments) break outer;
      const changes = simplifyChanges([...plan, ...extra]);
      if (changes.length === 0) continue;
      const e = runExperiment(experiments.length + 1, base, 'Relieve the busiest station', changes, constraints, costs, sim);
      experiments.push(e);
      steps.push({ kind: 'experiment', experiment: e });
      // Each added change must earn its place: at least 5 more points of improvement.
      if (e.status === 'accepted' && e.evidence!.nominal.improvement >= bestImprovement + MIN_MARGINAL_GAIN) {
        plan = changes;
        bestImprovement = e.evidence!.nominal.improvement;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  const stopReason = experiments.length >= maxExperiments ? 'experiment_budget' : 'finished';
  steps.push({ kind: 'stop', reason: stopReason, message: stopReason === 'finished' ? 'No further change helped.' : `Stopped at the experiment budget (${maxExperiments}).` });
  return {
    baseline, bottleneck: findBottleneck(baseline), experiments, recommended: pickRecommended(experiments),
    steps, stopReason, summary: null, llmCalls: 0, tokens: 0,
  };
}
