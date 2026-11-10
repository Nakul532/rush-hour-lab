// "Observed café" preset: Nakul's Bay Area café, with task times calibrated
// on 18 observed orders. Produced by `npm run calibrate`; see calibration/REPORT.md.
// If the calibration is rerun and picks different values, the script says so.

import { OBSERVED_ORDERS } from '../data/observed';
import { littleLawArrivalRate, observedCafeSpec, observedMix, type FitParams } from '../calibration/observedCafe';
import type { CafeSpec } from '../sim/cafe';

/** SIMULATED parameters fitted to OBSERVED waits (n = 18). */
export const OBSERVED_CAFE_FIT: FitParams = {
  drinkMedian: 2.25,
  foodMedian: 3.5,
  sigma: 0.2,
  prepMode: 'sequential',
};

/** Whether the preset includes grab-and-go items (kept only if it improved leave-one-out coverage). */
export const OBSERVED_CAFE_GRAB_GO = true;

export const OBSERVED_CAFE_LABEL = 'Calibrated on 18 observed orders from one session at a Bay Area café';

export function observedCafePreset(): CafeSpec {
  return observedCafeSpec(
    OBSERVED_CAFE_FIT,
    littleLawArrivalRate(OBSERVED_ORDERS),
    observedMix(OBSERVED_ORDERS, OBSERVED_CAFE_GRAB_GO),
  );
}
