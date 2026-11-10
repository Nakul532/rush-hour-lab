// Presets in display order. The observed café is the primary example.
import type { CafeSpec } from '../sim/cafe';
import { CURIO_LABEL, CURIO_NOT_IMPLEMENTED, curioPreset } from './curio';
import { OBSERVED_CAFE_LABEL, observedCafePreset } from './observedCafe';

export interface Preset {
  id: string;
  primary: boolean;
  title: string;
  /** Provenance labels shown wherever the preset appears. */
  labels: string[];
  build: () => CafeSpec;
}

export const PRESETS: readonly Preset[] = [
  { id: 'observed', primary: true, title: 'A Bay Area café (observed)', labels: [OBSERVED_CAFE_LABEL], build: observedCafePreset },
  { id: 'curio', primary: false, title: 'Curio Coffee (reconstructed)', labels: [CURIO_LABEL, CURIO_NOT_IMPLEMENTED], build: curioPreset },
];
