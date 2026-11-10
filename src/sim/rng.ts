// Seeded random numbers. We never use Math.random, so the same seed always
// gives the same simulation.
//
// Generator: xoshiro128** (Blackman & Vigna), seeded through a splitmix32-style
// hash so that nearby seeds (1, 2, 3...) still give unrelated streams.

function hash32(x: number): number {
  let z = (x + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

/** Combine several integers into one well-mixed 32-bit seed. */
export function mixSeed(...parts: number[]): number {
  let h = 0x2545f491;
  for (const p of parts) h = hash32(h ^ (p >>> 0));
  return h >>> 0;
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    let x = seed >>> 0;
    const next = () => (x = hash32(x));
    this.s0 = next() | 0;
    this.s1 = next() | 0;
    this.s2 = next() | 0;
    this.s3 = next() | 0;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform number in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }
}
