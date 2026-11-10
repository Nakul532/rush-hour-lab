# DATA.md: the only numbers you may use

## 1. Observed: Nakul's timed orders (Bay Area café, one moderate-traffic session)
18 orders. "wait" = minutes from order to receiving it.

| # | logged time | wait (min) | type | people in queue |
|---|---|---|---|---|
| 1 | 10.51 | 4 | drink | 3 |
| 2 | 10.52 | 3 | drink | 2 |
| 3 | 10.54 | 7 | drink + food | 1 |
| 4 | 10.56 | 8 | drink | 4 |
| 5 | 10.56 | 9 | drink | 3 |
| 6 | 10.56 | 1 | drink | 3 |
| 7 | 10.57 | 3 | food | 2 |
| 8 | 10.57 | 2 | food | 3 |
| 9 | 10.58 | 13 | food | 3 |
| 10 | 10.56 | 14 | food | 3 |
| 11 | 10.56 | 5 | drink | 31 (likely typo for 3; treat as unknown) |
| 12 | 10.57 | 16 | drink | 3 |
| 13 | 10.5 | 17 | drink + food | 3 |
| 14 | 10.5 | 18 | drink + food | 3 |
| 15 | 10.5 | 19 | drink + food | 3 |
| 16 | 10.5 | 8 | drink + food | 3 |
| 17 | 10.5 | 1 | drink | 3 |
| 18 | 10.5 | 2 | drink | 3 |

Data notes: "10.5" times are ambiguous (likely 10:50); logged times are not reliable for arrival rates, so use this table for service/wait times only. Summary: overall median ~7.5 min; drink-only median ~4 min; drink + food median ~17 min (n=5). Small sample: state it everywhere.

## 2. Public data for arrival patterns (choose one, record licence and provenance)
- Maven Roasters "Coffee Shop Sales" (Maven Analytics / Kaggle): 149,116 transactions, Jan–Jun 2023, 3 NYC locations, with timestamps. Maven describes it as a FICTITIOUS coffee shop: label it "synthetic benchmark dataset".
- Edinburgh café dataset (Kaggle): ~9,465 transactions / 60,457 item rows. Check the Kaggle page to confirm it's real café data before calling it real.
- "Coffee Shop Sales" by Yaroslav Isaienkov (Kaggle): ~3,898 transactions, Mar 2024–early 2025. Check its description.
Use transaction timestamps to build an arrival-rate curve per 15-minute bucket, scaled to the café being modelled.

## 3. Published benchmarks (cross-checks only, cite them)
- UTHM queuing study (coffee shop, one week, M/M/1): one day showed arrival rate 0.2792/min, service rate 0.5630/min, average time in system 3.52 min, utilization ~50%.
- City Observatory "Cappuccino Congestion Index": typical coffee shop ~650 transactions/day; average wait ~2.5 min; Portland observations: order placement 30–40 s rising to 2–3 min when congested.

## 4. Curio Coffee preset (from a 2025 class Lean proposal; not implemented)
- Peak: ~300 orders across 2 peak hours; 60% of daily sales between 7:30 and 9:30.
- Sales mix: espresso drinks ~40% of sales; Liège waffles ~35%.
- Current-state value stream: order 1 min; cashier entry 1–2 min; barista 4–5 min; kitchen waffle prep 6–7 min; packaging/handoff 1–2 min; total 13–17 min. Staff reported 8–12 min waits.
- Proposal's ideas (good candidate experiments): POS with preset buttons, parallel drink and waffle prep, 30-minute waffle batching, dedicated handoff zone, 5S station layout.
- Do NOT use the proposal's revenue/savings figures ($31,200, $40,536, $8,500); they contain calculation errors.
