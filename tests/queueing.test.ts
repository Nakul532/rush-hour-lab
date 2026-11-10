// Test 1 from the brief: a single-station setup must match queueing formulas.
import { describe, expect, it } from 'vitest';
import { runReplications } from '../src/sim/replicate';
import { mean } from '../src/sim/stats';
import { mmcConfig, mmcTheory } from './helpers';

// PUBLISHED BENCHMARK: UTHM coffee-shop queuing study, one day (M/M/1).
const UTHM = { lambda: 0.2792, mu: 0.563, reportedW: 3.52 };

describe('M/M/1 (UTHM coffee-shop rates)', () => {
  const theory = mmcTheory(UTHM.lambda, UTHM.mu, 1);
  // 20 replications × 20,000 simulated minutes (~5,600 customers each), first 500 minutes discarded.
  const runs = runReplications(mmcConfig(UTHM.lambda, UTHM.mu, 1, 20_000, 500), 20, 2026);

  it('textbook formula gives W = 1/(μ − λ) = 3.52 min, matching UTHM', () => {
    expect(theory.W).toBeCloseTo(1 / (0.563 - 0.2792), 10);
    expect(theory.W.toFixed(2)).toBe('3.52');
  });

  it('simulated time in system is within 3% of 3.52 min', () => {
    const W = mean(runs.map((r) => r.timeInSystem.mean));
    expect(Math.abs(W - UTHM.reportedW) / UTHM.reportedW).toBeLessThan(0.03);
  });

  it('simulated utilization is within 3% of ρ = λ/μ ≈ 0.496', () => {
    const util = mean(runs.map((r) => r.stations.counter.utilization as number));
    expect(Math.abs(util - theory.rho) / theory.rho).toBeLessThan(0.03);
  });

  it('simulated average number in the café is within 5% of L = ρ/(1 − ρ)', () => {
    const L = mean(runs.map((r) => r.little.L));
    const expected = theory.rho / (1 - theory.rho);
    expect(Math.abs(L - expected) / expected).toBeLessThan(0.05);
  });
});

describe('M/M/3 (multi-server check, Erlang C)', () => {
  const lambda = 1.0;
  const mu = 0.4;
  const theory = mmcTheory(lambda, mu, 3); // ρ ≈ 0.83, a busy café
  const runs = runReplications(mmcConfig(lambda, mu, 3, 20_000, 1_000), 20, 7);

  it('simulated time in system is within 4% of the Erlang C result', () => {
    const W = mean(runs.map((r) => r.timeInSystem.mean));
    expect(Math.abs(W - theory.W) / theory.W).toBeLessThan(0.04);
  });

  it('simulated utilization is within 3% of ρ', () => {
    const util = mean(runs.map((r) => r.stations.counter.utilization as number));
    expect(Math.abs(util - theory.rho) / theory.rho).toBeLessThan(0.03);
  });
});
