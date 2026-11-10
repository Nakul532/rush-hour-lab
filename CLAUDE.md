# Build brief: Rush Hour Lab

An AI operations analyst for small cafés that runs its own experiments. The agent builds a simulation of the café's rush, forms hypotheses, tests changes in the simulator, and only recommends what the evidence supports. Read DATA.md before writing code: it holds every real number you may use.

Owner: Nakul. Explain your plan before each stage and wait for his approval. He must understand every step.

## Who it's for
Independent café owners and managers who lose customers to long morning-rush waits and can't afford a consultant. Their question: "What should I change, without hiring anyone or spending much, to cut waits?"

## Non-negotiable honesty rules
- Every number shown carries its provenance: OBSERVED (Nakul's 18 timed orders), PUBLIC DATA (named dataset), PUBLISHED BENCHMARK (named study), or SIMULATED. Never present simulated or benchmark numbers as observed.
- Show sample sizes ("calibrated on 18 observed orders").
- The Curio Coffee preset is based on a class proposal; label it "based on a 2025 Lean proposal; recommendations were not implemented".
- This is decision support, not a guarantee. Say so on the results screen.
- No customer personal data anywhere.

## Stack ($0)
- Static web app (Vite + React + TypeScript, or plain TS), hosted on Vercel Hobby.
- The simulation runs entirely in the browser (Web Worker), so it costs nothing.
- One Vercel serverless function calls Groq (OpenAI-compatible API, gpt-oss-120b) for the agent. Key in Vercel env vars only (GROQ_API_KEY). Cap: max 15 LLM calls per analysis, a site-wide daily cap safely under Groq's free limits, and a friendly limit message (never an error page).
- No database needed for v1.

## Stage 1: Simulation engine (must be correct before anything else)
- Discrete-event simulation of one rush window.
- Arrivals: non-homogeneous Poisson process, rate per 15-minute bucket (from the arrival curve, see DATA.md).
- Order types: drink only, food only, drink + food, with configurable mix.
- Stations: cashier → barista and/or kitchen → handoff. Each station has a number of servers and a service-time distribution (lognormal, fitted to the observed data), FIFO.
- Configurable options the agent can change: staff per station per time window, parallel drink/food prep vs sequential, food batching interval, a dedicated handoff point, order-type routing.
- Outputs per run: median and 90th-percentile wait by order type, orders served, utilization per station, max queue length. Run N replications with a fixed seed and report 95% confidence intervals.
- Unit tests: (1) for a single-station setup, results match M/M/1 queueing formulas within tolerance; (2) Little's law holds (L = λW); (3) same seed gives identical results.
- Calibration check: with the "observed café" preset, simulated median waits must land close to the observed medians (drink-only ~4 min; drink + food ~17 min). Report the error. If it's far off, adjust the service-time fit and explain what changed.

## Stage 2: The agent (the AI does the core work)
Tools the agent can call: `build_model(description)`, `run_simulation(config)`, `find_bottleneck(results)`, `compare(a, b)`, `sensitivity(config, ±30%)`.
1. Model builder: turns a plain-English description ("one cashier, two baristas, one waffle iron, food is slow") into a simulation config. The user sees and confirms the config before anything runs.
2. Experiment loop: hypothesis → change → simulate → observe → decide the next experiment. Respects constraints the user sets (e.g. "no new hires", "budget under $500", "max 2 changes"). Hard stop at the experiment budget.
3. Acceptance rule (deterministic, not the model's opinion): a change is recommended only if it improves 90th-percentile wait by at least 10% AND still improves it when service times are ±30% (sensitivity). Everything else is shown as "tested and rejected" with its numbers.
4. What-if chat: "What if I add a barista on Saturdays 8–10?" → the agent changes the config, runs it, answers with numbers.
5. "Agent steps" panel shows each hypothesis, experiment and result.

## Stage 3: Evaluation (this is the headline)
- Build 15 documented test café scenarios with varied layouts, staffing and order mixes. Keep each scenario's change space small enough to brute-force (≤ 300 combinations).
- Ground truth: exhaustive search finds the truly best plan per scenario under its constraints.
- Measure: % of scenarios where the agent finds the optimal plan; % within 5% of optimal; simulations used by the agent vs brute force; acceptance-rule false positives.
- Also evaluate the model builder: 10 hand-written café descriptions with correct configs; score field-level accuracy.
- Lock scenarios and scoring before running; commit them first.
- Write eval/README.md: method, results table, one chart, honest limitations (synthetic scenarios, small n, calibration on 18 orders).

## Stage 4: Ship
- Landing: one sentence on what it does, a "Try the Curio Coffee example" button, and a "Describe your café" box.
- Results screen: before/after waits with confidence intervals, recommended changes with evidence, rejected ideas, provenance badges.
- A short case-study page: problem, data sources, method, eval results, limitations.
- Deploy on Vercel. Run the full checklist on the live URL.

## Copy rules
Plain, specific, active voice. No hype words (revolutionary, seamless, cutting-edge, leverage, robust). Sentence case.
