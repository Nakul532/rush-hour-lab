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

## Addendum 1 (post-lock run, committed before running)

Three changes after the first results, each run as a separately labelled post-lock run; the original results stay as they were.

1. **Agent loop: retry empty replies.** gpt-oss sometimes returns an empty reply (no text, no tool call). The loop now retries the same request up to 2 times instead of counting it towards "stop". Everything else (prompts, limits, scoring) is unchanged. The 15 original scenarios are re-run with this loop and reported as "post-lock run".
2. **Five interacting-changes scenarios** (`eval/scenariosInteracting.ts`), locked in this commit before brute force, greedy or the agent ran on them. They were designed by probing single changes and the intended pairs only. Mechanisms: superadditive (I1–I3) and budget trap (I4–I5). Same searchers, scoring and limits as the original 15.
3. **Model builder prompt fix for stated zeros.** The fix was written after seeing B01–B10 failures, so B01–B10 are reported but are no longer a fair test. Five held-out cases (H01–H05) were committed before the fix ran (commit `31f3b71`) and are the fair test.

Spending cap for this addendum: $1.00 of OpenRouter credit.
