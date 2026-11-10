// npm run calibrate  (~20 minutes)
// Fits the observed-café model to the 18 observed orders, with and without
// grab-and-go items, keeps grab-and-go only if it improves leave-one-out
// coverage, checks how much the fit depends on the assumed arrival rate, and
// writes calibration/REPORT.md and calibration/results.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { OBSERVED_ORDERS, OBSERVED_PROVENANCE, OBSERVED_TYPES, type ObservedType } from '../src/data/observed';
import { bestFit, onGridEdge, range, replicateObserved, simulateGrid, simulatePoint, targetsFrom, type GridPoint, type GridSpec } from '../src/calibration/fit';
import { ASSUMPTIONS, GRAB_GO_MAX_WAIT, littleLawArrivalRate, observedCafeConfig, observedMix, type FitParams } from '../src/calibration/observedCafe';
import { bootstrapMedians, leaveOneOut, type LooRow } from '../src/calibration/validate';
import { OBSERVED_CAFE_FIT, OBSERVED_CAFE_GRAB_GO } from '../src/presets/observedCafe';
import { mean } from '../src/sim/stats';
import { ORDER_TYPE_LABEL, type OrderType } from '../src/sim/types';

const SEED = 20261109;
const GRID_REPS = 300;
const FINAL_REPS = 1000;
const GRID: GridSpec = {
  drinkMedian: range(0.5, 3.5, 0.25),
  foodMedian: range(1, 7, 0.25),
  sigma: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0],
  prepMode: ['parallel', 'sequential'],
};
const SENSITIVITY_FACTORS = [0.8, 1.2];

// Starting guess before calibration: PUBLISHED BENCHMARK, Curio value stream
// (barista 4–5 min → 4.5; kitchen 6–7 min → 6.5), parallel prep.
const STARTING_GUESS: FitParams = { drinkMedian: 4.5, foodMedian: 6.5, sigma: 0.5, prepMode: 'parallel' };

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
const describe = (p: FitParams) => `drink ${f2(p.drinkMedian)} min, food ${f2(p.foodMedian)} min, spread ${f2(p.sigma)}, ${p.prepMode} prep`;
const label = (t: ObservedType) => ORDER_TYPE_LABEL[t];
const log = (msg: string) => console.log(`[calibrate] ${msg}`);

const orders = OBSERVED_ORDERS;
const baseRate = littleLawArrivalRate(orders);
const targets = targetsFrom(orders);
const boot = bootstrapMedians(orders);

// Simulated grids, cached by (rate, mix): leave-one-out folds share a few mixes.
type Mix = Partial<Record<OrderType, number>>;
const cache = new Map<string, GridPoint[]>();
function gridFor(mix: Mix, rate = baseRate): GridPoint[] {
  const key = JSON.stringify([rate, mix]);
  let pts = cache.get(key);
  if (!pts) {
    const t0 = Date.now();
    pts = simulateGrid(GRID, rate, mix, GRID_REPS, SEED);
    cache.set(key, pts);
    log(`grid ${cache.size}: rate ${rate.toFixed(3)}/min, mix ${JSON.stringify(mix)} — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  return pts;
}

// ---- 1. Fit both models; leave-one-out for each ----
const models = [
  { key: 'base', name: 'Without grab-and-go', grab: false },
  { key: 'grab', name: 'With grab-and-go', grab: true },
].map((m) => {
  const mix = observedMix(orders, m.grab);
  const points = gridFor(mix);
  const best = bestFit(points, targets);
  const loo = leaveOneOut(orders, (o) => observedMix(o, m.grab), (mx) => gridFor(mx));
  const final = replicateObserved(observedCafeConfig(best.point.params, baseRate, mix), FINAL_REPS, SEED);
  const inside = loo.filter((r) => r.inside).length;
  log(`${m.name}: ${describe(best.point.params)}; leave-one-out ${inside}/18`);
  return { ...m, mix, points, best, loo, inside, final, edges: onGridEdge(best.point.params, GRID) };
});
const [base, grab] = models;
const kept = grab.inside > base.inside ? grab : base;
log(`keeping: ${kept.name}`);

// ---- 2. Sensitivity to the arrival rate (kept model) ----
const sensitivity = [
  { factor: 1.0, rate: baseRate, best: kept.best, edges: kept.edges },
  ...SENSITIVITY_FACTORS.map((factor) => {
    const rate = baseRate * factor;
    const best = bestFit(gridFor(kept.mix, rate), targets);
    return { factor, rate, best, edges: onGridEdge(best.point.params, GRID) };
  }),
].sort((a, b) => a.factor - b.factor);

// ---- 3. Starting guess and a medians-only variant ----
const start = simulatePoint(STARTING_GUESS, baseRate, observedMix(orders, false), GRID_REPS, SEED);
const medianScore = (p: GridPoint) => OBSERVED_TYPES.reduce((s, t) => s + targets.byType[t].n * (p.sim[t].median - targets.byType[t].median) ** 2, 0);
const medianOnlyBest = kept.points.reduce((a, b) => (medianScore(b) < medianScore(a) ? b : a));

// ---- Report ----
const fitted = kept.best.point.params;
const presetMatches = JSON.stringify(OBSERVED_CAFE_FIT) === JSON.stringify(fitted) && OBSERVED_CAFE_GRAB_GO === kept.grab;
const lines: string[] = [];
const L = (s = '') => lines.push(s);
const nOf = (t: ObservedType) => targets.byType[t].n;
const misses = (loo: LooRow[]) => loo.filter((r) => !r.inside).map((r) => `#${r.id} (${r.observed} min)`).join(', ') || 'none';
const width = (loo: LooRow[]) => mean(loo.map((r) => r.high - r.low));
const looErr = (loo: LooRow[]) => mean(loo.map((r) => Math.abs(r.observed - r.predictedMedian)));

L('# Calibration report: observed café');
L();
L(`Generated by \`npm run calibrate\` (seed ${SEED}). Calibrated on 18 observed orders from one session. Small sample: treat every number here as rough.`);
L();
L("Provenance labels: **OBSERVED** = Nakul's 18 timed orders. **PUBLISHED BENCHMARK** = named study. **ASSUMPTION** = our choice, not measured. **SIMULATED** = model output.");
L();
L('## 1. What we matched against (OBSERVED)');
L();
L(`${OBSERVED_PROVENANCE}. "Wait" = order placed → order received.`);
L();
L('| Order type | n | Median wait | 90th percentile | 95% bootstrap range for the median |');
L('|---|---|---|---|---|');
for (const t of OBSERVED_TYPES) L(`| ${label(t)} | ${nOf(t)} | ${f1(targets.byType[t].median)} min | ${f1(targets.byType[t].p90)} min | ${f1(boot[t].low)}–${f1(boot[t].high)} min |`);
L();
L('The bootstrap range shows how much each observed median could move with a different handful of orders. With 4–9 orders per type it is wide.');
L();
L('## 2. Assumptions (not fitted)');
L();
for (const v of Object.values(ASSUMPTIONS)) L(`- ${v}`);
L(`- Assumed arrival rate: **${baseRate.toFixed(3)} customers/min** (≈ ${(baseRate * 60).toFixed(0)}/hour).`);
L();
L('## 3. What we fitted and how');
L();
L('Four settings: median drink time, median food time, their spread (lognormal sigma), and whether drink + food orders are made in parallel or one after the other.');
L(`For each model we simulated every combination on a grid (${GRID_REPS} replications per setting, same customers for each setting) and kept the one with the lowest score:`);
L();
L('score = Σ over order types of n × [(simulated median − observed median)² + (simulated 90th pct − observed 90th pct)²]');
L();
L('We match the 90th percentile as well as the median because the bad-case wait is what the agent will try to cut. Simulated grab-and-go orders are compared with the observed drink-only orders, since that is how they were logged.');
L();
L('## 4. Grab-and-go test: before and after');
L();
L(`Question: do the very short drink waits (1–3 min) come from ready items such as drip coffee? We added a grab-and-go order type: the cashier hands over a ready item (~0.3 min, no barista). Its share comes from the data: drink-only orders with waits of ${GRAB_GO_MAX_WAIT} min or less (4 of 9). Rule agreed in advance: keep it only if leave-one-out coverage improves on the model without it.`);
L();
L('In leave-one-out, everything learned from the data (order mix, grab-and-go share, task times) is relearned without the held-out order. Only the arrival rate still uses all 18.');
L();
L('| | Fitted setting | Drink only median | Food only median | Drink + food median | Leave-one-out: inside 90% range | Average range width | Missed orders |');
L('|---|---|---|---|---|---|---|---|');
for (const m of models) {
  L(`| ${m.name} | ${describe(m.best.point.params)} | ${f1(m.final.drink.median.mean)} | ${f1(m.final.food.median.mean)} | ${f1(m.final.drinkFood.median.mean)} | **${m.inside} of 18** | ${f1(width(m.loo))} min | ${misses(m.loo)} |`);
}
L(`| OBSERVED | | ${f1(targets.byType.drink.median)} | ${f1(targets.byType.food.median)} | ${f1(targets.byType.drinkFood.median)} | | | |`);
L();
L(`Leave-one-out error predicting each held-out wait (model median): ${f1(looErr(base.loo))} min without grab-and-go, ${f1(looErr(grab.loo))} min with it.`);
L();
L(kept.grab
  ? `**Decision: keep grab-and-go.** Coverage improved from ${base.inside} to ${grab.inside} of 18.`
  : `**Decision: drop grab-and-go.** Coverage did not improve (${base.inside} → ${grab.inside} of 18), so the preset stays without it.`);
L();
L(`## 5. Starting guess vs fitted (SIMULATED, ${kept.name.toLowerCase()})`);
L();
L('Pooled over all replications.');
L();
L('| | Setting | Drink only median / p90 | Food only median / p90 | Drink + food median / p90 | Barista busy | Kitchen busy |');
L('|---|---|---|---|---|---|---|');
const row = (name: string, p: GridPoint) =>
  L(`| ${name} | ${describe(p.params)} | ${f1(p.sim.drink.median)} / ${f1(p.sim.drink.p90)} | ${f1(p.sim.food.median)} / ${f1(p.sim.food.p90)} | ${f1(p.sim.drinkFood.median)} / ${f1(p.sim.drinkFood.p90)} | ${(p.utilization.barista * 100).toFixed(0)}% | ${(p.utilization.kitchen * 100).toFixed(0)}% |`);
row('Starting guess (Curio benchmark times, no grab-and-go)', start);
row('**Fitted (median + p90)**', kept.best.point);
row('Variant: fitted on medians only', medianOnlyBest);
L(`| OBSERVED | | ${f1(targets.byType.drink.median)} / ${f1(targets.byType.drink.p90)} | ${f1(targets.byType.food.median)} / ${f1(targets.byType.food.p90)} | ${f1(targets.byType.drinkFood.median)} / ${f1(targets.byType.drinkFood.p90)} | | |`);
L();
L("**What changed and why.** Curio's task times (barista 4.5 min, kitchen 6.5 min) overload a single barista at this arrival rate, so simulated waits explode. This café's drinks and food must be much quicker. The fit lowers both times sharply" +
  (fitted.prepMode === 'sequential' ? ' and picks sequential prep (drink first, then food), which pushes drink + food waits above food-only waits.' : ' and keeps parallel prep.'));
if (kept.edges.length) L(`\n⚠ The fitted ${kept.edges.join(', ')} sits on the edge of the search grid; the grid may be too narrow.`);
L();
L(`## 6. Calibration check (SIMULATED, ${FINAL_REPS} replications, mean with 95% CI)`);
L();
L('| Order type | Simulated median wait | Observed median (n) | Error | Inside bootstrap range? | Simulated p90 | Observed p90 |');
L('|---|---|---|---|---|---|---|');
for (const t of OBSERVED_TYPES) {
  const m = kept.final[t].median;
  const err = m.mean - targets.byType[t].median;
  const inside = m.mean >= boot[t].low && m.mean <= boot[t].high;
  L(`| ${label(t)} | ${f1(m.mean)} min (${f1(m.low)}–${f1(m.high)}) | ${f1(targets.byType[t].median)} min (${nOf(t)}) | ${err >= 0 ? '+' : ''}${f1(err)} min | ${inside ? 'yes' : 'no'} | ${f1(kept.final[t].p90.mean)} min | ${f1(targets.byType[t].p90)} min |`);
}
L();
L("This table is the engine's standard output: each replication is one simulated rush, and we average its median and 90th percentile across replications. One rush has only ~15–20 orders of each type, the same scale as the observed sample, so its median runs a little higher and its 90th percentile a little lower than in section 5, which pools all replications into one large sample.");
L();
L('## 7. Accepted gap: drink + food waits');
L();
const dfGap = targets.byType.drinkFood.median - kept.final.drinkFood.median.mean;
L('**Decision (Nakul, 2026-11-09): accept the gap and document it. No separate combined-order setting is added.**');
L();
L(`The model's drink + food median comes out ${f1(dfGap)} min shorter than the observed 17 min. Why we accept it:`);
L();
L('- **No task-time setting closes it.** The observed drink + food waits are tightly bunched (17, 18, 19 min) while food-only waits ranged 2–14 min. Pushing simulated combined orders toward 17 min inflates their simulated 90th percentile far beyond the observed 18.6 min (see the medians-only variant in section 5).');
L('- **The 17-minute median may rest on one group order.** Orders #13, #14 and #15 were all logged at "10.5" with the same queue count and waits of 17, 18 and 19 min. They look like one group served together, not three independent orders. If so, the drink + food sample is closer to 3 independent observations than 5, and its median is very uncertain.');
L(`- **The simulated median is inside the observed range.** ${f1(kept.final.drinkFood.median.mean)} min falls within the 95% bootstrap range for the observed median (${f1(boot.drinkFood.low)}–${f1(boot.drinkFood.high)} min).`);
L('- **Adding a combined-order setting would fit 5 orders with one more knob**, which would mostly fit noise.');
L();
L('What this means downstream: simulated waits for drink + food orders in this preset are probably optimistic. The agent and results screen must not present them as matching the observed café.');
L();
L('## 8. Sensitivity to the assumed arrival rate');
L();
L(`The arrival rate is an assumption, so we refitted the kept model (${kept.name.toLowerCase()}) at 80% and 120% of it.`);
L();
L('| Arrival rate | Fitted setting | Drink time vs 100% | Food time vs 100% | Score |');
L('|---|---|---|---|---|');
for (const s of sensitivity) {
  const p = s.best.point.params;
  L(`| ${(s.factor * 100).toFixed(0)}% → ${s.rate.toFixed(3)}/min | ${describe(p)} | ${pct(p.drinkMedian / fitted.drinkMedian - 1)} | ${pct(p.foodMedian / fitted.foodMedian - 1)} | ${f1(s.best.score)} |`);
}
L();
const dr = sensitivity.map((s) => s.best.point.params.drinkMedian);
const fr = sensitivity.map((s) => s.best.point.params.foodMedian);
L(`Across ±20% arrival rate the fitted drink time ranges ${f2(Math.min(...dr))}–${f2(Math.max(...dr))} min and the food time ${f2(Math.min(...fr))}–${f2(Math.max(...fr))} min. More customers means the fit needs quicker tasks to produce the same waits.`);
for (const s of sensitivity) if (s.edges.length) L(`\n⚠ At ${(s.factor * 100).toFixed(0)}% the fitted ${s.edges.join(', ')} is on the grid edge.`);
L();
L(`## 9. Leave-one-out detail (${kept.name.toLowerCase()})`);
L();
L(`**${kept.inside} of 18 held-out orders fall inside the predicted 90% range** (a well-calibrated range would catch about 16).`);
L();
L('| # | Type | Observed | Predicted median | 90% range | Inside? | Refitted setting |');
L('|---|---|---|---|---|---|---|');
for (const r of kept.loo) L(`| ${r.id} | ${label(r.type)} | ${r.observed} | ${f1(r.predictedMedian)} | ${f1(r.low)}–${f1(r.high)} | ${r.inside ? 'yes' : '**no**'} | ${describe(r.fit)} |`);
L();
L(`No-model baseline (median of the other orders of the same type) misses held-out waits by ${f1(mean(kept.loo.map((r) => Math.abs(r.observed - r.naiveMedian))))} min on average, vs ${f1(looErr(kept.loo))} min for the model. Individual waits vary a lot, so neither predicts single orders well; the useful test is whether the range is honest.`);
L();
L('## 10. Limitations');
L();
L('- 18 orders from one session at one café; 4–9 per order type. Orders #13–15 may be one group order.');
L('- Waits were recorded in whole minutes.');
L('- Staffing, order-taking time, handoff time and arrival rate are assumptions, not measurements. The fitted task times are only meaningful together with them.');
L('- Four settings fitted to 18 points will always fit somewhat; the leave-one-out check is the fairer test.');
L('- Simulation confidence intervals measure simulation noise only, not how well the model matches the real café.');
L('- Decision support, not a guarantee.');
L();
L(presetMatches
  ? '`src/presets/observedCafe.ts` matches this fit.'
  : `⚠ \`src/presets/observedCafe.ts\` does not match this fit. Set OBSERVED_CAFE_FIT = ${JSON.stringify(fitted)} and OBSERVED_CAFE_GRAB_GO = ${kept.grab}.`);

mkdirSync('calibration', { recursive: true });
writeFileSync('calibration/REPORT.md', lines.join('\n') + '\n');
writeFileSync(
  'calibration/results.json',
  JSON.stringify(
    {
      seed: SEED, gridReps: GRID_REPS, finalReps: FINAL_REPS, baseRate, targets, bootstrap: boot,
      models: models.map((m) => ({
        key: m.key, mix: m.mix, fitted: m.best.point, score: m.best.score, edges: m.edges, final: m.final,
        leaveOneOut: { inside: m.inside, of: m.loo.length, meanRangeWidth: width(m.loo), meanAbsError: looErr(m.loo), rows: m.loo },
      })),
      kept: kept.key,
      startingGuess: start,
      medianOnlyVariant: medianOnlyBest,
      sensitivity: sensitivity.map((s) => ({ factor: s.factor, rate: s.rate, fit: s.best.point, score: s.best.score, edges: s.edges })),
      presetMatches,
    },
    null,
    2,
  ) + '\n',
);
log(`wrote calibration/REPORT.md and calibration/results.json (preset ${presetMatches ? 'matches' : 'DOES NOT match'} the fit)`);
