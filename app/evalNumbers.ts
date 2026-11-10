// Numbers for the case study page, read from the committed evaluation results
// at build time (nothing is typed in by hand).
import agentOrig from '../eval/results/agent.json';
import greedyOrig from '../eval/results/greedy.json';
import freshOrig from '../eval/results/fresh-check.json';
import builderOrig from '../eval/results/builder.json';
import agentB from '../eval/results-postlock-b/agent.json';
import agentI from '../eval/results-interacting/agent.json';
import greedyI from '../eval/results-interacting/greedy.json';
import freshI from '../eval/results-interacting/fresh-check.json';
import builderPost from '../eval/results-postlock/builder.json';

type Score = { foundOptimal: boolean; within5: boolean; simulations: number };
const n = (xs: Score[], k: 'foundOptimal' | 'within5') => xs.filter((x) => x[k]).length;
const sims = (xs: Score[]) => xs.reduce((a, x) => a + x.simulations, 0);
type B = { id: string; fields: number; correct: number; invented: string[] };
const acc = (xs: B[]) => {
  const f = xs.reduce((a, x) => a + x.fields, 0);
  const c = xs.reduce((a, x) => a + x.correct, 0);
  return { correct: c, fields: f, pct: Math.round((c / f) * 1000) / 10, invented: xs.reduce((a, x) => a + x.invented.length, 0) };
};

export const EVAL = {
  original: {
    agent: { best: n(agentOrig, 'foundOptimal'), within5: n(agentOrig, 'within5'), sims: sims(agentOrig) },
    agentRerun: { best: n(agentB, 'foundOptimal'), within5: n(agentB, 'within5') },
    greedy: { best: n(greedyOrig, 'foundOptimal'), sims: sims(greedyOrig) },
    falsePositives: freshOrig.filter((r: { holds: boolean }) => !r.holds).length,
    accepted: freshOrig.length,
  },
  interacting: {
    agent: { best: n(agentI, 'foundOptimal'), within5: n(agentI, 'within5') },
    greedy: { best: n(greedyI, 'foundOptimal') },
    falsePositives: freshI.filter((r: { holds: boolean }) => !r.holds).length,
    accepted: freshI.length,
  },
  builder: {
    before: acc(builderOrig.scores as B[]),
    afterSeen: acc((builderPost.scores as B[]).filter((s) => s.id.startsWith('B'))),
    heldOut: acc((builderPost.scores as B[]).filter((s) => s.id.startsWith('H'))),
  },
};
