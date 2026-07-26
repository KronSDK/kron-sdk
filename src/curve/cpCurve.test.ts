import { describe, it, expect } from 'vitest';
import { minOutWithSlippage, quoteCpBuy, quoteCpSell, type CpState } from './cpCurve.js';

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

// The mainnet fee schedule: a third `devFund` leg carved out of the platform share. Quotes that omit it
// under-fund the transaction, and builders that omit its OUTPUT get rejected by the covenant outright — so
// the leg must be driven entirely by `devFundBps` being present, never defaulted either way.
describe('dev-fund fee leg', () => {
  // Sized so every leg clears the FEE_OUT_MIN padding floor and the arithmetic is exact.
  const base: CpState = {
    realKas: 0n, tokenReserve: 1_000_000_000n, vKas: 6_250_000n,
    graduationKas: 25_000_000_000_000n, creatorFeeBps: 25n, platformFeeBps: 90n,
  };
  const devFund: CpState = { ...base, devFundBps: 10n };
  const kasIn = 100_000_000_000n; // 1000 KAS

  it('charges the leg on a buy and folds it into fee/total', () => {
    const q = quoteCpBuy(devFund, kasIn)!;
    expect(q.devFundFee).toBe(100_000_000n);                       // 10 bps of kasIn
    expect(q.fee).toBe(q.creatorFee + q.platformFee + q.devFundFee);
    expect(q.total).toBe(q.kasIn + q.fee);
  });

  it('deducts the leg from a sell net', () => {
    const q = quoteCpSell({ ...devFund, realKas: 500_000_000_000n }, 1_000_000n)!;
    expect(q.devFundFee).toBeGreaterThan(0n);
    expect(q.fee).toBe(q.creatorFee + q.platformFee + q.devFundFee);
    expect(q.net).toBe(q.kasOut - q.fee);
  });

  it('quotes 0n on an old-pinned token that has no leg', () => {
    const q = quoteCpBuy(base, kasIn)!;
    expect(q.devFundFee).toBe(0n);
    expect(q.fee).toBe(q.creatorFee + q.platformFee);
  });

  it('costs the buyer exactly the leg more than the same token without it', () => {
    expect(quoteCpBuy(devFund, kasIn)!.total - quoteCpBuy(base, kasIn)!.total).toBe(100_000_000n);
  });
});
