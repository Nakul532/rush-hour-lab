# Stage 3 evaluation protocol (locked before running)

Committed before any agent was run on these scenarios. Changes after this commit must be listed in eval/README.md under "Changes after locking".

## What is measured

1. **Agent search quality**: on 15 café scenarios, does the LLM agent find the truly best plan?
2. **Efficiency**: how many simulations it needs, against brute force and a simple greedy search.
3. **Acceptance-rule false positives**: how often a plan the rule accepts fails to hold up on a fresh, larger simulation.
4. **Model builder**: field-level accuracy turning 10 plain-English café descriptions into configs.

## Scenarios

`eval/scenarios.ts`: 15 cafés (13 SYNTHETIC, 1 OBSERVED-CALIBRATED, 1 RECONSTRUCTED), each with constraints and a change space of at most 300 plans. Designed to cover: a clear bottleneck, no-new-hires, budgets that force peak-only staffing, a café where nothing should pass, a plan the per-type rule should reject, process changes vs hires, and a large interacting space (288 plans).

## Searchers

- **Brute force**: evaluates every plan. Defines the ground truth.
- **Greedy**: starts from no change; each round tries every option of every unused lever and keeps the best accepted plan if it improves on the current one; stops when nothing improves. A simple non-LLM baseline.
- **LLM agent**: `runAnalysis` with the scenario's change space enforced by code, gpt-oss-120b via OpenRouter pinned to Groq (fallbacks disabled), reasoning effort low, temperature 0, at most 12 LLM calls and 6 experiments per scenario. One run per scenario.

All three use the same acceptance rule, seed and replications (`EVAL_SIM`: 200 replications, seed 31337), so the same plan gets the same numbers whoever tests it.

## Scoring

Definitions are in `eval/scoring.ts` (top comment): optimal plan, found optimal, within 5% (of the optimal p90 wait), simulations, false positive (fresh check with 1,000 replications, seed 271828: improvement ≥ 10% and paired CI excluding zero must still hold), and model-builder field accuracy with invented fields counted separately.

## Spending limits

LLM spend for the whole evaluation is capped at $1.00 of OpenRouter credit (checked against the account balance between scenarios) and 600,000 tokens. If a cap is hit, remaining scenarios are reported as not run.
