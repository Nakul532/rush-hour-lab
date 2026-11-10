// npm run eval:time-in-cafe
// Diagnostic added after locking (reported separately). "Wait" starts when
// the order is placed, matching how the 18 observed orders were timed. A plan
// could shorten that wait by holding people longer in the order line. This
// checks every accepted plan's p90 TIME IN CAFÉ (arrival → order received).

import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { applyChanges } from '../src/agent/changes';
import { runReplications } from '../src/sim/replicate';
import { buildConfig } from '../src/sim/cafe';
import { choiceChanges } from '../src/agent/space';
import { mean } from '../src/sim/stats';
import { SCENARIOS } from './scenarios';
import { INTERACTING } from './scenariosInteracting';
import { EVAL_SIM, type GroundTruth } from './scoring';

const sets = [
  { name: 'original', scenarios: SCENARIOS, file: 'eval/results/ground-truth.json' },
  { name: 'interacting', scenarios: INTERACTING, file: 'eval/results-interacting/ground-truth.json' },
];
const rows: Array<{ scenario: string; plan: string; optimal: boolean; waitImprovement: number; timeInCafeChange: number }> = [];
for (const set of sets) {
  const gts: GroundTruth[] = JSON.parse(readFileSync(set.file, 'utf8'));
  for (const s of set.scenarios) {
    const gt = gts.find((g) => g.scenario === s.id)!;
    const base = mean(runReplications(buildConfig(s.spec), EVAL_SIM.reps, EVAL_SIM.seed).map((r) => r.timeInSystem.p90));
    for (const p of gt.plans.filter((x) => x.status === 'accepted')) {
      const spec = applyChanges(s.spec, choiceChanges(s.space, p.key.split(',').map(Number)));
      const cand = mean(runReplications(buildConfig(spec), EVAL_SIM.reps, EVAL_SIM.seed).map((r) => r.timeInSystem.p90));
      rows.push({ scenario: s.id, plan: p.label, optimal: gt.optimal?.key === p.key, waitImprovement: p.improvement!, timeInCafeChange: (cand - base) / base });
    }
  }
}
const worse = rows.filter((r) => r.timeInCafeChange > 0);
const worse10 = rows.filter((r) => r.timeInCafeChange > 0.1);
writeFileSync('eval/results-postlock/time-in-cafe.json', JSON.stringify({ rows, worse: worse.length, worseBy10pct: worse10.length, of: rows.length }, null, 2) + '\n');
console.log(`[time-in-café] ${rows.length} accepted plans; time in café p90 worse in ${worse.length} (by >10% in ${worse10.length}); optimal plans worse: ${worse.filter((r) => r.optimal).length}`);
for (const r of worse) console.log(`  ${r.scenario} ${r.plan}${r.optimal ? ' (optimal)' : ''}: wait ${(r.waitImprovement * 100).toFixed(0)}% shorter, time in café ${(r.timeInCafeChange * 100).toFixed(0)}% longer`);
