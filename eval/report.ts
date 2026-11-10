// npm run eval:report — writes eval/README.md and eval/chart.svg from eval/results/.
import { readFileSync, writeFileSync } from 'node:fs';
import { SCENARIOS } from './scenarios';
import type { BuilderScore, GroundTruth, SearcherScore } from './scoring';

const R = (f: string) => JSON.parse(readFileSync(`eval/results/${f}`, 'utf8'));
const gts: GroundTruth[] = R('ground-truth.json');
const agent: SearcherScore[] = R('agent.json');
const greedy: SearcherScore[] = R('greedy.json');
const fresh: Array<{ holds: boolean; improvementEval: number; improvementFresh: number }> = R('fresh-check.json');
const runs = R('agent-runs.json');
const builder: { scores: BuilderScore[]; reportedCostUsd: number } = R('builder.json');

const by = <T extends { scenario: string }>(xs: T[], id: string) => xs.find((x) => x.scenario === id)!;
const f1 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(1));
const count = (xs: SearcherScore[], k: 'foundOptimal' | 'within5') => xs.filter((x) => x[k]).length;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- chart (static SVG)
// Dot plot: one row per scenario, x = overall p90 wait. Today (gray ring),
// best possible plan (blue circle), LLM agent's plan (orange diamond).
// Shapes differ as well as colours, so the chart reads without colour.
const W = 940, rowH = 30, top = 70, left = 360, right = 230;
const H = top + rowH * SCENARIOS.length + 50;
const maxX = Math.ceil(Math.max(...gts.map((g) => g.baseP90)) / 5) * 5;
const x = (v: number) => left + (v / maxX) * (W - left - right);
const C = { surface: '#fcfcfb', text: '#0b0b0b', muted: '#52514e', grid: '#e4e3df', today: '#8a8984', best: '#2a78d6', agent: '#eb6834' };
const svg: string[] = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-labelledby="t d">`);
svg.push(`<title id="t">Bad-case wait per scenario: today, best possible plan, LLM agent's plan</title>`);
svg.push(`<desc id="d">SIMULATED overall 90th-percentile wait in minutes for 15 evaluation scenarios. Table in eval/README.md.</desc>`);
svg.push(`<rect width="${W}" height="${H}" fill="${C.surface}"/>`);
svg.push(`<text x="16" y="26" font-size="15" font-weight="600" fill="${C.text}">Bad-case (p90) wait, minutes: today vs best possible vs LLM agent</text>`);
// legend
const lg = (cx: number, shape: string, label: string) => `${shape}<text x="${cx + 14}" y="50" font-size="12" fill="${C.muted}">${label}</text>`;
svg.push(lg(16, `<circle cx="22" cy="46" r="5" fill="none" stroke="${C.today}" stroke-width="2"/>`, 'Today'));
svg.push(lg(90, `<circle cx="96" cy="46" r="5" fill="${C.best}" stroke="${C.surface}" stroke-width="2"/>`, 'Best possible plan (brute force)'));
svg.push(lg(320, `<path d="M326 40 l6 6 l-6 6 l-6 -6 z" fill="${C.agent}" stroke="${C.surface}" stroke-width="2"/>`, "LLM agent's plan"));
// grid
for (let v = 0; v <= maxX; v += 5) {
  svg.push(`<line x1="${x(v)}" x2="${x(v)}" y1="${top - 8}" y2="${top + rowH * SCENARIOS.length}" stroke="${C.grid}" stroke-width="1"/>`);
  svg.push(`<text x="${x(v)}" y="${top + rowH * SCENARIOS.length + 18}" font-size="11" fill="${C.muted}" text-anchor="middle">${v}</text>`);
}
svg.push(`<text x="${(left + W - right) / 2}" y="${H - 8}" font-size="11" fill="${C.muted}" text-anchor="middle">minutes (SIMULATED)</text>`);
SCENARIOS.forEach((s, i) => {
  const y = top + rowH * i + rowH / 2;
  const g = by(gts, s.id);
  const a = by(agent, s.id);
  const best = g.optimal?.candidateP90 ?? g.baseP90;
  const ag = a.recommendedP90 ?? g.baseP90;
  svg.push(`<text x="16" y="${y + 4}" font-size="12" fill="${C.text}">${s.id} ${s.title.length > 50 ? s.title.slice(0, 49) + '…' : s.title}</text>`);
  if (g.optimal) {
    svg.push(`<line x1="${x(Math.min(best, ag))}" x2="${x(g.baseP90)}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="2"/>`);
    svg.push(`<circle cx="${x(g.baseP90)}" cy="${y}" r="5" fill="none" stroke="${C.today}" stroke-width="2"/>`);
    svg.push(`<circle cx="${x(best)}" cy="${y}" r="5.5" fill="${C.best}" stroke="${C.surface}" stroke-width="2"/>`);
    if (a.recommendedP90 !== null) svg.push(`<path d="M${x(ag)} ${y - 6} l6 6 l-6 6 l-6 -6 z" fill="${C.agent}" stroke="${C.surface}" stroke-width="2"/>`);
  } else {
    svg.push(`<circle cx="${x(g.baseP90)}" cy="${y}" r="5" fill="none" stroke="${C.today}" stroke-width="2"/>`);
  }
  const mark = !g.optimal
    ? (a.recommendedKey === null ? 'nothing passes; agent: nothing ✓' : 'nothing passes')
    : a.foundOptimal ? 'agent found best ✓' : a.within5 ? 'agent within 5%' : a.recommendedKey === null ? 'agent: nothing' : 'agent missed';
  svg.push(`<text x="${W - right + 16}" y="${y + 4}" font-size="11" fill="${C.muted}">${mark}</text>`);
});
svg.push('</svg>');
writeFileSync('eval/chart.svg', svg.join('\n') + '\n');

// ---------------------------------------------------------------- README
const L: string[] = [];
const P = (s = '') => L.push(s);
const agentSims = sum(agent.map((a) => a.simulations));
const greedySims = sum(greedy.map((a) => a.simulations));
const bruteSims = sum(gts.map((g) => g.simulations));
const fp = fresh.filter((r) => !r.holds).length;
const minFresh = Math.min(...fresh.map((r) => r.improvementFresh));
const bFields = sum(builder.scores.map((s) => s.fields));
const bCorrect = sum(builder.scores.map((s) => s.correct));
const bInvented = sum(builder.scores.map((s) => s.invented.length));
const stops: Record<string, number> = {};
for (const r of runs.runs) stops[r.stopReason] = (stops[r.stopReason] ?? 0) + 1;
const emptyReplies = sum(runs.runs.map((r: { errors: string[] }) => r.errors.filter((e) => e.startsWith('The model replied without calling a tool')).length));

P('# Stage 3 evaluation results');
P();
P('All waits are **SIMULATED**. 13 of the 15 cafés are **SYNTHETIC** (invented for testing); S10 is the café calibrated on 18 observed orders and S09 is reconstructed from a 2025 class proposal. Method: [PROTOCOL.md](PROTOCOL.md). Scenarios and scoring were committed before any agent ran (commit `ca79299`).');
P();
P('## Headline');
P();
P('| | Found the best plan | Within 5% of best | Simulations used |');
P('|---|---|---|---|');
P(`| LLM agent (gpt-oss-120b) | **${count(agent, 'foundOptimal')} of 15** | ${count(agent, 'within5')} of 15 | ${agentSims} |`);
P(`| Greedy search (no LLM) | ${count(greedy, 'foundOptimal')} of 15 | ${count(greedy, 'within5')} of 15 | ${greedySims} |`);
P(`| Brute force (every plan) | 15 of 15 (by definition) | 15 of 15 | ${bruteSims} |`);
P();
const misses = agent.filter((a) => !a.foundOptimal);
const missStops: Record<string, number> = {};
let subsetMisses = 0;
for (const a of misses) {
  const r = runs.runs.find((x: { scenario: string }) => x.scenario === a.scenario);
  missStops[r.stopReason] = (missStops[r.stopReason] ?? 0) + 1;
  const best = (by(gts, a.scenario).optimal?.label ?? '').split(' + ');
  if (a.recommendedKey !== null && a.recommendedLabel.split(' + ').every((p) => best.includes(p))) subsetMisses++;
}
P(`- **The LLM agent is worse than a simple greedy search here.** It found the best plan in ${count(agent, 'foundOptimal')} of 15 scenarios; greedy found it in all 15. It used about half as many simulations (${agentSims} vs ${greedySims} for greedy, ${bruteSims} for brute force), partly because it often stopped early.`);
P(`- **Why it missed (${misses.length} scenarios).** ${missStops.no_tool_call ?? 0} runs stopped early: ${emptyReplies} times in all the model returned an empty reply (no text, no tool call) after reasoning, and the loop treats two empty replies in a row as "stop". ${missStops.experiment_budget ?? 0} used the full experiment budget without trying the winning combination, and ${missStops.finished ?? 0} chose to finish early. In ${subsetMisses} of the misses the agent's plan was part of the best plan, one or two changes short.`);
P(`- **The acceptance rule held up: ${fp} false positives in ${fresh.length} accepted plans.** Every plan the rule accepted still showed ≥10% improvement with a paired 95% CI above zero on a fresh seed with 5× the replications (smallest fresh improvement: ${(minFresh * 100).toFixed(1)}%).`);
P(`- **The agent never recommended a plan the rule rejected** (it cannot: recommendations come only from accepted experiments), and in the two scenarios where nothing passes (S12, S15) it correctly recommended nothing.`);
P(`- **Model builder: ${bCorrect} of ${bFields} stated fields correct (${((bCorrect / bFields) * 100).toFixed(1)}%), ${bInvented} invented.**`);
P();
P('![Bad-case wait per scenario](chart.svg)');
P();
P('## Per scenario');
P();
P('p90 = overall 90th-percentile wait, minutes, SIMULATED (200 replications, seed 31337).');
P();
P('| Scenario | Plans | Today p90 | Best plan (brute force) | Best p90 | LLM agent plan | Agent p90 | Agent result | Agent sims | Greedy sims |');
P('|---|---|---|---|---|---|---|---|---|---|');
for (const s of SCENARIOS) {
  const g = by(gts, s.id);
  const a = by(agent, s.id);
  const gr = by(greedy, s.id);
  const res = a.foundOptimal ? 'best' : a.within5 ? 'within 5%' : 'miss';
  P(`| ${s.id} ${s.title} | ${g.plans.length} | ${f1(g.baseP90)} | ${g.optimal?.label ?? 'Nothing passes'} | ${f1(g.optimal?.candidateP90 ?? null)} | ${a.recommendedLabel} | ${f1(a.recommendedP90)} | ${res} | ${a.simulations} | ${gr.simulations} |`);
}
P();
P('Agent stop reasons: ' + Object.entries(stops).map(([k, v]) => `${k} ${v}`).join(', ') + '.');
P();
P('## Model builder (10 descriptions)');
P();
P('| Case | Fields correct | Wrong or missing | Invented |');
P('|---|---|---|---|');
for (const s of builder.scores) P(`| ${s.id} | ${s.correct} / ${s.fields} | ${s.wrong.map((w) => `${w.field} (expected ${JSON.stringify(w.expected)}, got ${w.got === undefined ? 'nothing' : JSON.stringify(w.got)})`).join('; ') || '—'} | ${s.invented.join(', ') || '—'} |`);
P();
P('Patterns: (1) stated zeros are dropped ("no kitchen staff", "drinks only"); (2) in B03 the mix came back as fractions (0.5, 0.2, 0.3) instead of percentages. That scores as wrong under the locked rules, but the simulator treats the mix as relative weights, so the café built is the same; (3) one missed "drink first, then food".');
P();
P('## Cost');
P();
P(`LLM agent: ${runs.tokens.toLocaleString('en-US')} tokens; OpenRouter reported $${runs.reportedCostUsd.toFixed(4)} per call in total (account balance delta $${runs.creditsUsedUsd.toFixed(4)}). Model builder: $${builder.reportedCostUsd.toFixed(4)}. Model: gpt-oss-120b via OpenRouter, pinned to Groq, fallbacks disabled.`);
P();
P('## Changes after locking');
P();
P('None to scenarios, scoring or the agent. One observation: **S05 did not behave as designed.** It was meant as "nothing should pass", but its bad-case wait is short (5.6 min), so a 10% cut is about half a minute and 15 plans passed. It is scored against the brute-force truth like every other scenario.');
P();
P('## Limitations');
P();
P('- **Synthetic scenarios.** 13 of 15 cafés are invented; real cafés may have larger or messier option spaces.');
P('- **Small n.** 15 scenarios, one LLM run each. The model runs at temperature 0, but outputs can still vary run to run; no repeat runs were made.');
P('- **Small change spaces favour greedy.** With 24–288 plans and mostly independent levers, step-by-step search is close to exhaustive. The comparison says little about large or tightly coupled spaces.');
P('- **Calibration on 18 orders.** The only real-data café (S10) is calibrated on 18 observed orders from one session, and its drink + food waits run about 5.6 min short of what was observed.');
P('- **False-positive check is within the model.** It tests whether accepted plans survive simulation noise, not whether they work in a real café.');
P('- **Model builder scoring is strict** (exact fields); it does not score whether a wrong field changes the café built.');
writeFileSync('eval/README.md', L.join('\n') + '\n');
console.log('[report] wrote eval/README.md and eval/chart.svg');
