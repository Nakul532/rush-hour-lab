# Rush Hour Lab

An operations analyst for small cafés that tests changes in a simulator before recommending them. See CLAUDE.md for the build brief and DATA.md for every real number the project may use.

## Status

Stage 1 (simulation engine) is built. The observed-café preset is calibrated on 18 observed orders; drink + food waits come out about 5.6 min short of the observed median, an accepted and documented gap (calibration/REPORT.md §7). Stage 2 (the agent) is built and tested with a mocked LLM; a capped live test against Groq is next. Evaluation and the web app come later.

## Commands

```bash
npm install
npm test            # unit tests + calibration check
npm run typecheck
npm run calibrate   # refits the observed café (~20 min), writes calibration/REPORT.md
npm run live-run -- --live   # one-off live agent test on Groq, capped at 40K tokens (needs GROQ_API_KEY in .env.local)
```

## Layout

| Path | What it is |
|---|---|
| `src/sim/engine.ts` | Discrete-event simulation of one rush window |
| `src/sim/cafe.ts` | A café in everyday terms (staff, prep mode, batching, handoff, routing, grab-and-go) → engine config |
| `src/sim/replicate.ts` | Many replications with a fixed seed, 95% confidence intervals |
| `src/sim/arrivals.ts` | Arrivals with a rate per 15-minute bucket (non-homogeneous Poisson) |
| `src/data/observed.ts` | The 18 observed orders (OBSERVED) |
| `src/calibration/` | Model of the observed café, grid fit, bootstrap, leave-one-out |
| `src/presets/observedCafe.ts` | Calibrated observed-café preset |
| `calibration/REPORT.md` | Calibration results, assumptions and limitations |
| `src/agent/changes.ts` | The menu of changes the agent may propose, checked and applied by code |
| `src/agent/plan.ts` | Costs (user-entered; defaults are ASSUMPTIONS) and constraints |
| `src/agent/evaluate.ts` | Simulate, bottleneck, paired compare, ±30% sensitivity, acceptance rule |
| `src/agent/agent.ts` | Experiment loop (LLM proposes, code decides; 15-call cap) |
| `src/agent/whatIf.ts`, `modelBuilder.ts` | What-if chat and plain-English → config |
| `src/agent/llm.ts`, `groq.ts` | LLM interface, mock, token budget, Groq client |
| `src/agent/heuristic.ts` | Rule-based baseline agent (no LLM) |
| `tests/` | M/M/1 and M/M/3 checks, Little's law, determinism, routing, batching, calibration, agent (mocked LLM) |

## How the simulation works

Customers arrive at random, faster in busy 15-minute buckets. Each gets an order type (drink, food, both, or a grab-and-go ready item) and a random time for each task, drawn from a lognormal distribution. Orders go cashier → barista and/or kitchen → handoff. Each station has a number of staff (which can change during the rush) and serves first come, first served. "Wait" means order placed → order received.

Every result from the engine is SIMULATED. Confidence intervals measure simulation noise, not how closely the model matches a real café.

## Acceptance rule (code, not the model)

A change is recommended only if all of these hold:

1. Overall 90th-percentile wait improves by at least 10%.
2. The paired 95% CI of that improvement excludes zero (both plans run on the same simulated customers).
3. It still improves with every task 30% faster, and with every task 30% slower.
4. No single order type's 90th-percentile wait gets more than 10% worse.
5. Every order is served.

Everything else is shown as "tested and rejected" with its numbers. Numbers shown to users always come from code; text the LLM writes is dropped if it contains digits.
