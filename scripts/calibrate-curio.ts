// npm run calibrate:curio  (~1 minute)
// Fits the single scale factor for the reconstructed Curio preset so the
// simulated median wait matches the 8–12 min staff reported (target 10),
// and writes calibration/CURIO.md.

import { mkdirSync, writeFileSync } from 'node:fs';
import { simulate } from '../src/agent/evaluate';
import { range } from '../src/calibration/fit';
import { CURIO_ASSUMPTIONS, CURIO_LABEL, CURIO_NOT_IMPLEMENTED, CURIO_REPORTED_WAIT, CURIO_SCALE, CURIO_VALUE_STREAM, curioSpec } from '../src/presets/curio';
import { ORDER_TYPE_LABEL } from '../src/sim/types';

const SIM = { reps: 300, seed: 20261109 };
const TARGET = (CURIO_REPORTED_WAIT.low + CURIO_REPORTED_WAIT.high) / 2;

const rows = range(0.2, 0.5, 0.01).map((k) => ({ k, s: simulate(curioSpec(k), SIM).summary }));
const best = rows.reduce((a, b) => (Math.abs(b.s.overall.median.mean - TARGET) < Math.abs(a.s.overall.median.mean - TARGET) ? b : a));
const f1 = (x: number) => x.toFixed(1);
const k = best.k;
const s = best.s;
const vs = CURIO_VALUE_STREAM;
const sumVs = vs.order + vs.drink + vs.food + vs.handoff;

const L: string[] = [];
L.push('# Curio Coffee preset: reconstruction notes', '');
L.push(`**${CURIO_LABEL}.** ${CURIO_NOT_IMPLEMENTED}. This is a secondary example; the primary example is the observed café (calibration/REPORT.md).`, '');
L.push('## Why the original figures are inconsistent', '');
L.push('The proposal (DATA.md §4) gives three sets of numbers that cannot all be true at once:', '');
L.push('1. **Volume:** about 300 orders across the 2 peak hours (60% of daily sales between 7:30 and 9:30). That is 2.5 orders a minute, or 150 an hour.');
L.push(`2. **Step times:** order 1 min, cashier entry 1–2, barista 4–5, kitchen waffle prep 6–7, packaging/handoff 1–2 (total 13–17 min).`);
L.push('3. **Reported waits:** staff said customers wait 8–12 min.', '');
L.push('If the step times were hands-on work, 2.5 orders a minute would need about 6 people on the register (2.5 × 2.5 min), about 9 baristas (2 drink orders a minute × 4.5 min) and about 9 people on waffles (1.4 waffle orders a minute × 6.5 min) just to keep up. A small café does not have 24 staff on a morning shift.');
L.push('The step times also add up to 13–17 min, longer than the 8–12 min wait staff reported.', '');
L.push('Most likely the step times are elapsed times from a value-stream walk, including time spent waiting in each queue, and "300 orders" may count items rather than orders. The proposal\'s revenue and savings figures also contain calculation errors and are not used anywhere.', '');
L.push('## How we reconstructed it', '');
for (const a of CURIO_ASSUMPTIONS) L.push(`- ${a}`);
L.push('');
L.push(`Hands-on task times = elapsed step time × a scale factor. We tried factors from 0.20 to 0.50 (${SIM.reps} replications each) and kept the one whose simulated median wait is closest to ${TARGET} min, the middle of the 8–12 min staff reported.`, '');
L.push(`**Fitted scale factor: ${k.toFixed(2)}.** ${k === CURIO_SCALE ? '`src/presets/curio.ts` matches.' : `⚠ src/presets/curio.ts has ${CURIO_SCALE}; set CURIO_SCALE = ${k.toFixed(2)}.`}`, '');
L.push('| Step | Proposal (elapsed, min) | Reconstructed hands-on median (min) |', '|---|---|---|');
L.push(`| Order + cashier entry | ${vs.order} | ${f1(vs.order * k)} |`);
L.push(`| Barista (drink) | ${vs.drink} | ${f1(vs.drink * k)} |`);
L.push(`| Kitchen (waffle) | ${vs.food} | ${f1(vs.food * k)} |`);
L.push(`| Packaging / handoff | ${vs.handoff} | ${f1(vs.handoff * k)} |`);
L.push(`| Total | ${sumVs} | ${f1(sumVs * k)} |`, '');
L.push('## Result (SIMULATED, mean across replications with 95% CI)', '');
L.push(`Median wait (order placed → received): **${f1(s.overall.median.mean)} min** (${f1(s.overall.median.low)}–${f1(s.overall.median.high)}); staff reported 8–12. 90th percentile: ${f1(s.overall.p90.mean)} min.`, '');
L.push('| Order type | Median wait | p90 wait |', '|---|---|---|');
for (const [t, v] of Object.entries(s.byType)) L.push(`| ${ORDER_TYPE_LABEL[t as keyof typeof ORDER_TYPE_LABEL]} | ${f1(v!.median.mean)} min | ${f1(v!.p90.mean)} min |`);
L.push('');
L.push(`Busy share: ${Object.entries(s.stations).map(([id, v]) => `${id} ${Math.round((v.utilization ?? 0) * 100)}%`).join(', ')}. Orders served per rush: ${f1(s.ordersServed.mean)}.`, '');
L.push('## Scale factor vs median wait', '', '| Scale | Median wait | p90 wait |', '|---|---|---|');
for (const r of rows) L.push(`| ${r.k.toFixed(2)} | ${f1(r.s.overall.median.mean)} | ${f1(r.s.overall.p90.mean)} |`);
L.push('');
L.push('## Limits', '');
L.push('- One number (the scale factor) fitted to one reported range. Nothing here was measured; treat this café as an illustration, not evidence.');
L.push('- The fitted café runs close to capacity (cashier and baristas around 90% busy), so small changes in volume move waits a lot.');
L.push('- Staffing is our assumption. Different staffing would need a different scale factor.');
mkdirSync('calibration', { recursive: true });
writeFileSync('calibration/CURIO.md', L.join('\n') + '\n');
console.log(`[curio] scale ${k.toFixed(2)} → median ${f1(s.overall.median.mean)} min, p90 ${f1(s.overall.p90.mean)} min; preset ${k === CURIO_SCALE ? 'matches' : 'DOES NOT match'}`);
