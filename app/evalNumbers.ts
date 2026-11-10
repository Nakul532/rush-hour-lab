// Numbers for the case study page, from eval/results/summary.json, which
// eval/report.ts generates from the committed results (nothing typed by hand).
import summary from '../eval/results/summary.json';

export const EVAL = summary;
export const TOTAL = {
  scenarios: summary.original.scenarios + summary.interacting.scenarios,
  plans: summary.original.plans + summary.interacting.plans,
  agentBest: summary.original.agent.best + summary.interacting.agent.best,
  greedyBest: summary.original.greedy.best + summary.interacting.greedy.best,
  agentSims: summary.original.agent.sims + summary.interacting.agent.sims,
  greedySims: summary.original.greedy.sims + summary.interacting.greedy.sims,
  bruteSims: summary.original.bruteSims + summary.interacting.bruteSims,
};
