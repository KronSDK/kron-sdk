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

// A sell whose gross kasOut falls below the PADDED fee floor nets NEGATIVE: each fee leg is floored at
// FEE_OUT_MIN (0.2 KAS), so the three legs cost a fixed 0.6 KAS regardless of trade size, and the seller hands
// over tokens AND pays KAS to sell them. The only pre-existing smallness guard bounds the GROSS kasOut, never
// the net. `null` is this function's declared "not sellable" contract — an integrator who never reads a
// changelog reads `.net`, and a negative number there builds a value-destroying transaction.
describe('quoteCpSell net-positivity (padded fee floor)', () => {
  // A real live mainnet curve shape (NOSE, ~4.89 KAS raised) — shallow curves are where the floor bites.
  const live: CpState = {
    realKas: 489_000_000n, tokenReserve: 899_940_151n, vKas: 6_499_675n,
    graduationKas: 25_998_700_000_000n, creatorFeeBps: 25n, platformFeeBps: 90n, devFundBps: 10n,
  };

  it('returns null instead of a negative-net quote', () => {
    expect(quoteCpSell(live, 1_000n)).toBeNull();   // gross ~0.07 KAS against a 0.6 KAS fee floor
  });

  it('rejects an exactly-zero net (the seller gains nothing but still pays the network fee)', () => {
    const q = quoteCpSell(live, 8_445n);
    if (q) expect(q.net).toBeGreaterThan(0n);       // 8,445 grosses exactly 0.60 KAS ⇒ net exactly 0
  });

  it('does NOT over-block: the first net-positive size still quotes', () => {
    const q = quoteCpSell(live, 8_446n)!;
    expect(q.kasOut).toBe(61_000_000n);             // 0.61 KAS gross
    expect(q.fee).toBe(60_000_000n);                // 3 x FEE_OUT_MIN — every leg still padded
    expect(q.net).toBe(1_000_000n);                 // 0.01 KAS
  });

  it('never returns a non-positive net anywhere in the small-sell band', () => {
    for (let t = 1n; t <= 20_000n; t += 37n) {
      const q = quoteCpSell(live, t);
      if (q) expect(q.net).toBeGreaterThan(0n);
    }
  });

  it('leaves an ordinary-size sell untouched', () => {
    const deep: CpState = { ...live, realKas: 500_000_000_000n, tokenReserve: 1_000_000_000n, vKas: 6_250_000n };
    const q = quoteCpSell(deep, 1_000_000n)!;
    expect(q.net).toBe(q.kasOut - q.fee);
    expect(q.net).toBeGreaterThan(6_000_000_000n);  // ~66 KAS — unaffected by the guard
  });
});
