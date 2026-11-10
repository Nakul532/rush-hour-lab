# "Wait" starts at the till: a second gameable metric

*Case-study note for Stage 4. All numbers SIMULATED.*

## What happened

"Wait" runs from placing the order to receiving it, which matches how the 18 observed orders were timed. During Stage 3 we noticed a faster till can make "wait" look longer even though customers leave sooner (S06: +1 cashier, wait 67% longer, time in café 7% shorter). We checked all 167 accepted evaluation plans: none made time in the café worse, so we only changed the display to show both numbers.

Then, testing the live app on the reconstructed Curio café with "no new hires", the recommender proposed **moving a cashier to the kitchen**: bad-case wait 16.7 → 5.7 min (66% shorter), every check passed, $0. Time in the café went from **43 to 169 minutes**. With one cashier left, the order line grew without limit. People waited outside the measured window, so the metric improved.

Same lesson as the unserved-orders bug: the optimizer found the cheapest way to move the number, which was to stop the number seeing the problem.

## Fix

The acceptance rule gained a seventh check: **time in café (arrival → order received, p90) must not get more than 10% worse.** Re-running brute force on all 20 evaluation scenarios with the new check changed no plan's status and no best plan (the evaluation cafés' cashiers had spare capacity; Curio's are 92% busy).

## The empty-station bug, twice

The same session found a related bug a second time: the hybrid search applied changes without the empty-station check the agent's input had, so two moves off a two-person register left nobody taking orders (and, with batch cooking, the simulator ran forever). After the fix, one shared `validatePlan()` checks every staffing window during the rush, and every path uses it: the LLM agent and what-if (through `parseChanges`), and greedy, brute force, the hybrid, the rule-based baseline and the evaluation (through `runExperiment`). `tests/agent/validator.test.ts` sends an empty-station plan through each path. The engine also has a hard time limit, so an impossible café ends with its orders counted as unserved instead of hanging.
