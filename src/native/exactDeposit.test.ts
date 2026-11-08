// A deposit into a graduated pool pays exactly the price of the whole shares its budget buys (KRON, 2026-11-08). Both pool
// programs (amm_pool_cp_v3.sil, pool_kcc20.sil) take any dKas and require only dShares = floor(S·dKas/K) and dToken =
// ceil(T·dShares/S), so the exact quote is the floored quote at a smaller dKas: the same shares and tokens as the whole budget,
// without the KAS that would mint nothing. Swept over fixed and pseudo-random pools: the programs' four inequalities, the
// identity with quoteAddLiquidity, and the two families' exact quotes agreeing.
import { describe, it, expect } from 'vitest';
import { quoteAddLiquidity, quoteAddLiquidityExact, addMinDKas, type PoolCpState } from './poolCpTx.js';
import { quoteAddLiquidityExactV1 } from './poolKcc20Tx.js';

type Reserves = Pick<PoolCpState, 'kasReserve' | 'tokenReserve' | 'totalShares'>;
const full = (r: Reserves): PoolCpState => ({ ...r, tokenCovid: new Uint8Array(32), lpCovid: new Uint8Array(32) });
const KRON_POOL: Reserves = { kasReserve: 40_943_040n, tokenReserve: 61_267_331n, totalShares: 1_145_274n }; // mainnet, 2026-11-08

// deterministic pseudo-random reserves inside the programs' bounds (9e8 KAS units, 4e18 raw token units, 1e7 shares)
let seed = 0x2026_1108n;
const next = (below: bigint): bigint => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n; return seed % below; };
const pools: Reserves[] = [
  KRON_POOL,
  { kasReserve: 100_000n, tokenReserve: 1_000_000n, totalShares: 1000n },
  { kasReserve: 5000n, tokenReserve: 100_000n, totalShares: 2000n },
  { kasReserve: 7n, tokenReserve: 13n, totalShares: 1000n },
  { kasReserve: 1n, tokenReserve: 1n, totalShares: 1n },
  { kasReserve: 800_000_000n, tokenReserve: 3_900_000_000_000_000_001n, totalShares: 5_000_000n },
  { kasReserve: 899_999_999n, tokenReserve: 999_999_999n, totalShares: 9_999_999n },
  ...Array.from({ length: 200 }, () => ({ kasReserve: 1n + next(900_000_000n), tokenReserve: 1n + next(4n * 10n ** 18n), totalShares: 1n + next(9_999_999n) })),
  // more shares than KAS units: a unit buys several shares, where the floor and the ceiling sit closest
  ...Array.from({ length: 50 }, () => { const S = 2n + next(9_999_998n); return { kasReserve: 1n + next(S - 1n), tokenReserve: 1n + next(10n ** 12n), totalShares: S }; }),
];
const budgets = (r: Reserves): bigint[] => {
  const min = addMinDKas(full(r)), room = 900_000_000n - r.kasReserve;
  return [min - 1n, min, min + 1n, 3n * min + 1n, ...Array.from({ length: 6 }, () => 1n + next(room > 1n ? room : 1n))].filter((b) => b >= 1n);
};

describe('poolCp.quoteAddLiquidityExact', () => {
  it("KRON's pool: 1 KAS buys 2 shares for 0.72 KAS, where the whole-budget quote gave the pool 0.28 KAS for nothing", () => {
    const whole = quoteAddLiquidity(full(KRON_POOL), 100n), exact = quoteAddLiquidityExact(KRON_POOL, 100n)!;
    expect([whole.dKas, whole.dShares, whole.dToken]).toEqual([100n, 2n, 107n]);
    expect([exact.dKas, exact.dShares, exact.dToken]).toEqual([72n, 2n, 107n]);
    expect(quoteAddLiquidityExact(KRON_POOL, 10_000n)).toMatchObject({ dKas: 9_975n, dShares: 279n, dToken: 14_926n });
  });

  it('pays no more than the budget and the least KAS for its shares, in the pair both programs require', () => {
    let quoted = 0;
    for (const r of pools) for (const b of budgets(r)) {
      const K = r.kasReserve, T = r.tokenReserve, S = r.totalShares, q = quoteAddLiquidityExact(r, b);
      const at = `K=${K} T=${T} S=${S} budget=${b}`;
      if (S * b < K) { expect(q, at).toBeNull(); continue; }
      expect(q, at).not.toBeNull(); quoted++;
      const { dKas, dShares, dToken } = q!;
      expect(dKas >= 1n && dKas <= b && dShares >= 1n && dToken >= 1n, at).toBe(true);
      expect(dShares * K <= S * dKas && (dShares + 1n) * K > S * dKas, `${at}: dShares is the floor for dKas`).toBe(true);
      expect(dToken * S >= T * dShares && (dToken - 1n) * S < T * dShares, `${at}: dToken is the ceiling for dShares`).toBe(true);
      expect(S * (dKas - 1n) < dShares * K, `${at}: one unit less buys fewer shares`).toBe(true);
    }
    expect(quoted).toBeGreaterThan(1000);
  });

  it('is the floored quote at its own dKas, with the whole budget\'s shares and tokens', () => {
    for (const r of pools) for (const b of budgets(r)) {
      const q = quoteAddLiquidityExact(r, b);
      if (!q) continue;
      const whole = quoteAddLiquidity(full(r), b);
      expect(quoteAddLiquidity(full(r), q.dKas)).toEqual(q);
      expect([q.dShares, q.dToken]).toEqual([whole.dShares, whole.dToken]);
    }
  });

  it('agrees with poolKcc20.quoteAddLiquidityExactV1', () => {
    for (const r of pools) for (const b of budgets(r)) expect(quoteAddLiquidityExact(r, b)).toEqual(quoteAddLiquidityExactV1(r, b));
  });

  it('returns null for an empty pool, no budget, or a budget under one share', () => {
    expect(quoteAddLiquidityExact({ ...KRON_POOL, kasReserve: 0n }, 100n)).toBeNull();
    expect(quoteAddLiquidityExact({ ...KRON_POOL, totalShares: 0n }, 100n)).toBeNull();
    expect(quoteAddLiquidityExact(KRON_POOL, 0n)).toBeNull();
    expect(quoteAddLiquidityExact(KRON_POOL, 35n)).toBeNull(); // a share costs 35.75 units
    expect(quoteAddLiquidityExact(KRON_POOL, 36n)).toMatchObject({ dKas: 36n, dShares: 1n });
  });
});
