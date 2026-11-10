# The metric was gameable: testing caught it, and here is the fix

*Case-study note for Stage 4. All numbers are SIMULATED, from a SYNTHETIC test café (not real data).*

## What happened

The acceptance rule judges a change by the 90th-percentile wait of orders. While writing tests for the rule, before any language model had run, we probed it with hand-picked plans on a synthetic café (1 cashier, 1 barista, 1 kitchen person; the barista was the bottleneck).

One plan was "move the kitchen person to the barista station" (+1 barista, −1 kitchen). The rule accepted it:

| | Overall p90 wait | Checks passed | Cost |
|---|---|---|---|
| Today | 15.3 min | | |
| Move the cook to drinks | 2.8 min (82% shorter) | 5 of 5 | $0 |

That is too good to be true. With nobody in the kitchen, no food order is ever finished. The simulator only computed waits for orders that were handed over, so every food order simply vanished from the statistics, and the remaining drink orders were quick. The rule was rewarding a café that stops serving food.

No agent exploited this, but an agent searching for whatever passes the rule would have found it: it is free, it breaks no constraint, and it posts the biggest gain on the board.

## Why it slipped through

- **Survivorship in the metric.** Wait statistics covered completed orders only. "Orders that never finish" was not a number anyone looked at.
- **The earlier tests could not see it.** Stage 1's "everyone is served" test ran only on fully staffed cafés. Nothing tried a station with zero staff.
- **The rule checked improvement, not service.** All five checks were about how much shorter the wait was, none about whether orders were served at all.

## The fix (three layers)

1. **The engine reports it.** Every run now returns `unserved` (orders still waiting when the simulation ends).
2. **Code refuses the plan up front.** A plan that leaves any station that orders still go to with no staff at the end of the rush is rejected before simulation, with a message the agent can act on: "The plan leaves kitchen with no staff at the end of the rush, so some orders would never be served."
3. **The acceptance rule gained a sixth check: every order gets served**, at normal task times and at ±30%. This also catches slower failures, such as a station so overloaded that orders are still queued long after the rush.

Tests added: a plan that empties a station is refused (`tests/agent/changes.test.ts`), and a plan with unserved orders fails the rule (`tests/agent/acceptance.test.ts`). Commit `5fb1ebd`.

## The lesson

An optimizer, human or AI, finds the cheapest way to move the number it is judged by. If the number can improve by doing less of the job, something will eventually find that out. So:

- Report what is excluded from a metric, not just the metric.
- Probe the decision rule with adversarial plans before letting an agent loose on it, including absurd ones ("remove everyone").
- Treat a result that looks too good as a bug until proven otherwise.
