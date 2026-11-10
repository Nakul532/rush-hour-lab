# Stage 3 evaluation results

All waits are **SIMULATED**. 13 of the 15 cafés are **SYNTHETIC** (invented for testing); S10 is the café calibrated on 18 observed orders and S09 is reconstructed from a 2025 class proposal. Method: [PROTOCOL.md](PROTOCOL.md). Scenarios and scoring were committed before any agent ran (commit `ca79299`).

## Headline

| | Found the best plan | Within 5% of best | Simulations used |
|---|---|---|---|
| LLM agent (gpt-oss-120b) | **6 of 15** | 7 of 15 | 365 |
| Greedy search (no LLM) | 15 of 15 | 15 of 15 | 714 |
| Brute force (every plan) | 15 of 15 (by definition) | 15 of 15 | 1488 |

- **The LLM agent is worse than a simple greedy search here.** It found the best plan in 6 of 15 scenarios; greedy found it in all 15. It used about half as many simulations (365 vs 714 for greedy, 1488 for brute force), partly because it often stopped early.
- **Why it missed (9 scenarios).** 5 runs stopped early: 19 times in all the model returned an empty reply (no text, no tool call) after reasoning, and the loop treats two empty replies in a row as "stop". 2 used the full experiment budget without trying the winning combination, and 2 chose to finish early. In 5 of the misses the agent's plan was part of the best plan, one or two changes short.
- **The acceptance rule held up: 0 false positives in 130 accepted plans.** Every plan the rule accepted still showed ≥10% improvement with a paired 95% CI above zero on a fresh seed with 5× the replications (smallest fresh improvement: 10.5%).
- **The agent never recommended a plan the rule rejected** (it cannot: recommendations come only from accepted experiments), and in the two scenarios where nothing passes (S12, S15) it correctly recommended nothing.
- **Model builder: 57 of 70 stated fields correct (81.4%), 0 invented.**

![Bad-case wait per scenario](chart.svg)

## Per scenario

p90 = overall 90th-percentile wait, minutes, SIMULATED (200 replications, seed 31337).

| Scenario | Plans | Today p90 | Best plan (brute force) | Best p90 | LLM agent plan | Agent p90 | Agent result | Agent sims | Greedy sims |
|---|---|---|---|---|---|---|---|---|---|
| S01 Barista-bound, one change allowed | 72 | 15.9 | +1 barista | 10.3 | +1 barista | 10.3 | best | 26 | 42 |
| S02 Barista-bound, no new hires | 72 | 16.6 | cashier → barista + grab-and-go 40% + batches of 6 every 20 min | 5.9 | cashier → barista | 10.3 | miss | 20 | 66 |
| S03 Kitchen-bound, sequential prep, $500 budget | 36 | 31.5 | parallel prep + +1 kitchen 07:15–08:00 | 14.9 | +1 kitchen 07:15–08:00 | 16.7 | miss | 25 | 54 |
| S04 Peaked rush, $300 budget | 48 | 22.1 | grab-and-go 30% | 14.6 | grab-and-go 30% | 14.6 | best | 7 | 6 |
| S05 Quiet café: nothing should pass | 32 | 5.6 | +1 barista + +1 kitchen + grab-and-go 30% | 3.7 | +1 barista + +1 kitchen | 3.8 | within 5% | 25 | 84 |
| S06 Cashier-bound | 36 | 7.8 | +1 barista | 5.7 | +1 barista | 5.7 | best | 31 | 66 |
| S07 Barista slowed by handoffs, max 2 changes | 32 | 33.8 | +1 barista + grab-and-go 30% | 9.6 | +1 barista | 10.2 | miss | 31 | 54 |
| S08 Drink-heavy, $700 budget | 24 | 22.8 | +1 barista | 5.1 | +1 barista | 5.1 | best | 22 | 24 |
| S09 Curio Coffee (reconstructed), $1,000 budget | 96 | 17.3 | parallel prep + +1 barista | 9.6 | +1 barista | 11.2 | miss | 27 | 54 |
| S10 Observed café (calibrated), max 2 changes | 32 | 14.0 | +1 barista + +1 kitchen | 6.9 | parallel prep + +1 kitchen | 10.5 | miss | 21 | 54 |
| S11 Two peaks, $600 budget | 24 | 14.9 | +1 kitchen second peak + grab-and-go 30% | 10.5 | +1 barista first peak (07:00–07:45) + grab-and-go 30% | 11.3 | miss | 19 | 42 |
| S12 Kitchen-bound, no new hires, two baristas | 48 | 29.8 | Nothing passes | — | Nothing | — | best | 32 | 30 |
| S13 Largest space (288 plans), $1,000, max 3 changes | 288 | 31.8 | +1 barista 07:30–08:15 + +1 kitchen + parallel prep | 10.0 | +1 kitchen + grab-and-go 20% | 15.9 | miss | 27 | 84 |
| S14 Overloaded barista, $250 budget | 36 | 28.1 | grab-and-go 50% | 17.7 | grab-and-go 30% | 20.0 | miss | 20 | 30 |
| S15 Bakery-style food, no new hires | 32 | 30.9 | Nothing passes | — | Nothing | — | best | 32 | 24 |

Agent stop reasons: no_tool_call 7, experiment_budget 4, finished 3, llm_call_limit 1.

## Model builder (10 descriptions)

| Case | Fields correct | Wrong or missing | Invented |
|---|---|---|---|
| B01 | 8 / 8 | — | — |
| B02 | 5 / 6 | staff.kitchen (expected 0, got nothing) | — |
| B03 | 3 / 7 | mixPercent.drink (expected 50, got 0.5); mixPercent.food (expected 20, got 0.2); mixPercent.drinkFood (expected 30, got 0.3); prepMode (expected "sequential", got nothing) | — |
| B04 | 7 / 7 | — | — |
| B05 | 5 / 6 | staff.barista (expected 1, got nothing) | — |
| B06 | 4 / 4 | — | — |
| B07 | 4 / 8 | staff.kitchen (expected 0, got nothing); mixPercent.drink (expected 100, got nothing); mixPercent.food (expected 0, got nothing); mixPercent.drinkFood (expected 0, got nothing) | — |
| B08 | 7 / 10 | mixPercent.drink (expected 40, got nothing); mixPercent.food (expected 30, got nothing); mixPercent.drinkFood (expected 30, got nothing) | — |
| B09 | 5 / 5 | — | — |
| B10 | 9 / 9 | — | — |

Patterns: (1) stated zeros are dropped ("no kitchen staff", "drinks only"); (2) in B03 the mix came back as fractions (0.5, 0.2, 0.3) instead of percentages. That scores as wrong under the locked rules, but the simulator treats the mix as relative weights, so the café built is the same; (3) one missed "drink first, then food".

## Cost

LLM agent: 450,172 tokens; OpenRouter reported $0.0408 per call in total (account balance delta $0.0308). Model builder: $0.0016. Model: gpt-oss-120b via OpenRouter, pinned to Groq, fallbacks disabled.

## Changes after locking

None to scenarios, scoring or the agent. One observation: **S05 did not behave as designed.** It was meant as "nothing should pass", but its bad-case wait is short (5.6 min), so a 10% cut is about half a minute and 15 plans passed. It is scored against the brute-force truth like every other scenario.

## Limitations

- **Synthetic scenarios.** 13 of 15 cafés are invented; real cafés may have larger or messier option spaces.
- **Small n.** 15 scenarios, one LLM run each. The model runs at temperature 0, but outputs can still vary run to run; no repeat runs were made.
- **Small change spaces favour greedy.** With 24–288 plans and mostly independent levers, step-by-step search is close to exhaustive. The comparison says little about large or tightly coupled spaces.
- **Calibration on 18 orders.** The only real-data café (S10) is calibrated on 18 observed orders from one session, and its drink + food waits run about 5.6 min short of what was observed.
- **False-positive check is within the model.** It tests whether accepted plans survive simulation noise, not whether they work in a real café.
- **Model builder scoring is strict** (exact fields); it does not score whether a wrong field changes the café built.
