import { describe, it, expect } from 'vitest';
import { minOutWithSlippage } from './cpCurve.js';

describe('minOutWithSlippage (BUG 6 regression)', () => {
  it('applies a normal tolerance', () => {
    expect(minOutWithSlippage(1000n, 100)).toBe(990n); // 1% off
    expect(minOutWithSlippage(1000n, 0)).toBe(1000n);  // no tolerance
  });

  it('never returns negative for an out-of-range (>100%) tolerance', () => {
    expect(minOutWithSlippage(1000n, 15000)).toBe(0n); // clamped to 10000 bps → floor at 0
    expect(minOutWithSlippage(1000n, 10000)).toBe(0n); // exactly 100%
  });

  it('clamps a negative tolerance to 0', () => {
    expect(minOutWithSlippage(1000n, -500)).toBe(1000n);
  });
});
