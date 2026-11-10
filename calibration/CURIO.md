# Curio Coffee preset: reconstruction notes

**Reconstructed from a 2025 class proposal; original figures were inconsistent.** Based on a 2025 Lean proposal; recommendations were not implemented. This is a secondary example; the primary example is the observed café (calibration/REPORT.md).

## Why the original figures are inconsistent

The proposal (DATA.md §4) gives three sets of numbers that cannot all be true at once:

1. **Volume:** about 300 orders across the 2 peak hours (60% of daily sales between 7:30 and 9:30). That is 2.5 orders a minute, or 150 an hour.
2. **Step times:** order 1 min, cashier entry 1–2, barista 4–5, kitchen waffle prep 6–7, packaging/handoff 1–2 (total 13–17 min).
3. **Reported waits:** staff said customers wait 8–12 min.

If the step times were hands-on work, 2.5 orders a minute would need about 6 people on the register (2.5 × 2.5 min), about 9 baristas (2 drink orders a minute × 4.5 min) and about 9 people on waffles (1.4 waffle orders a minute × 6.5 min) just to keep up. A small café does not have 24 staff on a morning shift.
The step times also add up to 13–17 min, longer than the 8–12 min wait staff reported.

Most likely the step times are elapsed times from a value-stream walk, including time spent waiting in each queue, and "300 orders" may count items rather than orders. The proposal's revenue and savings figures also contain calculation errors and are not used anywhere.

## How we reconstructed it

- Volume: 300 orders in 2 hours, at a flat rate (proposal figure; see the inconsistency note)
- ASSUMPTION: 2 cashiers, 4 baristas, 3 kitchen staff (waffle irons); the baristas hand over orders
- ASSUMPTION: order mix 45% drink only, 20% waffle only, 35% drink + waffle (from sales shares: espresso ~40%, waffles ~35%)
- ASSUMPTION: drink first, then waffle (the proposal lists the steps in sequence and suggests parallel prep as an improvement)
- ASSUMPTION: task-time spread lognormal sigma 0.4
- Fitted: one scale factor turning elapsed step times into hands-on task times

Hands-on task times = elapsed step time × a scale factor. We tried factors from 0.20 to 0.50 (300 replications each) and kept the one whose simulated median wait is closest to 10 min, the middle of the 8–12 min staff reported.

**Fitted scale factor: 0.37.** `src/presets/curio.ts` matches.

| Step | Proposal (elapsed, min) | Reconstructed hands-on median (min) |
|---|---|---|
| Order + cashier entry | 2.5 | 0.9 |
| Barista (drink) | 4.5 | 1.7 |
| Kitchen (waffle) | 6.5 | 2.4 |
| Packaging / handoff | 1.5 | 0.6 |
| Total | 15 | 5.5 |

## Result (SIMULATED, mean across replications with 95% CI)

Median wait (order placed → received): **10.0 min** (9.6–10.4); staff reported 8–12. 90th percentile: 16.6 min.

| Order type | Median wait | p90 wait |
|---|---|---|
| Drink only | 8.2 min | 12.5 min |
| Food only | 9.0 min | 12.9 min |
| Drink + food | 13.8 min | 18.7 min |

Busy share: cashier 92%, barista 93%, kitchen 87%. Orders served per rush: 299.4.

## Scale factor vs median wait

| Scale | Median wait | p90 wait |
|---|---|---|
| 0.20 | 2.0 | 3.8 |
| 0.21 | 2.2 | 4.1 |
| 0.22 | 2.4 | 4.6 |
| 0.23 | 2.7 | 5.1 |
| 0.24 | 3.0 | 5.7 |
| 0.25 | 3.5 | 6.4 |
| 0.26 | 4.0 | 7.3 |
| 0.27 | 4.6 | 8.3 |
| 0.28 | 5.3 | 9.5 |
| 0.29 | 6.1 | 10.7 |
| 0.30 | 6.8 | 11.7 |
| 0.31 | 7.5 | 12.7 |
| 0.32 | 8.1 | 13.6 |
| 0.33 | 8.5 | 14.3 |
| 0.34 | 9.0 | 14.9 |
| 0.35 | 9.3 | 15.5 |
| 0.36 | 9.7 | 16.0 |
| 0.37 | 10.0 | 16.6 |
| 0.38 | 10.3 | 17.1 |
| 0.39 | 10.6 | 17.5 |
| 0.40 | 10.9 | 18.0 |
| 0.41 | 11.2 | 18.5 |
| 0.42 | 11.5 | 18.9 |
| 0.43 | 11.8 | 19.4 |
| 0.44 | 12.1 | 19.9 |
| 0.45 | 12.4 | 20.3 |
| 0.46 | 12.6 | 20.8 |
| 0.47 | 12.9 | 21.2 |
| 0.48 | 13.2 | 21.7 |
| 0.49 | 13.5 | 22.1 |
| 0.50 | 13.7 | 22.6 |

## Limits

- One number (the scale factor) fitted to one reported range. Nothing here was measured; treat this café as an illustration, not evidence.
- The fitted café runs close to capacity (cashier and baristas around 90% busy), so small changes in volume move waits a lot.
- Staffing is our assumption. Different staffing would need a different scale factor.
