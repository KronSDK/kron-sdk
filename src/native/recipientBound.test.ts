// Dual-ABI (HLK-L04 / HLK-L07 / HLK-L12) contract tests that run WITHOUT the private parity toolchain.
//
// WHY THIS FILE EXISTS SEPARATELY FROM verify:parity. The parity gate proves the recipient-bound builders
// are byte-identical to the kron reference — but only where BOTH sides build. The behavior that protects an
// integrator who wires the flags wrong is the throw-before-build path: a recipient witness pointing at a
// covenant input can never satisfy the covenant's presence proof, so the builders must refuse at build time
// rather than emit a transaction the VM rejects. Throws don't appear in the byte comparison, and every guard
// fires before the first WASM call — so they are testable here with a dummy `k` and dummy scripts.
// The HLK-L07 quote plumbing (allowZeroPayout) is pure math with no reference twin in the parity fixtures'
// legacy path, so its contract lives here too.
import { describe, it, expect } from 'vitest';
import { addressPresenceOwned, type Kcc20Template } from './kcc20Tx.js';
import {
  buildAddLiquidity, buildRemoveLiquidity, quoteAddLiquidity, quoteRemoveLiquidity, snapRemoveDShares,
  removeMinDShares, quotePoolCpBuy, quotePoolCpSell, MAX_SHARES,
  type PoolCpTemplate, type PoolCpState, type PoolCpParams, type PoolCpUtxo,
} from './poolCpTx.js';
import { buildPoolV3SwapKasForToken, buildPoolV3SwapTokenForKas } from './poolCpV3Tx.js';
import { buildCpBuy, buildCpSell, type CpTemplate } from './curveCpTx.js';

// Every guard under test throws BEFORE the first WASM call, so `k` is never touched.
const k = {} as any;
const B32 = (fill: number) => new Uint8Array(32).fill(fill);
const TXID = '1'.repeat(64);
const tokenTpl: Kcc20Template = { script: new Uint8Array(0), stateStart: 0, maxIns: 4, maxOuts: 4 };

// --- pool fixtures -------------------------------------------------------------------------------
const poolState: PoolCpState = {
  kasReserve: 78763432n, tokenReserve: 31891357n, tokenCovid: B32(0xab),
  totalShares: 1149416n, lpCovid: B32(0xdd),
};
const poolParams: PoolCpParams = {
  creatorFeeOwner: B32(1), platformFeeOwner: B32(2),
  creatorFeeBps: 10n, platformFeeBps: 70n, lpFeeBps: 20n, lockedShares: 1000000n,
};
const poolTpl = (recipientBound: boolean, canonicalInventoryRequired = false): PoolCpTemplate =>
  ({ script: new Uint8Array(0), stateStart: 0, recipientBound, canonicalInventoryRequired });
const poolUtxo: PoolCpUtxo = {
  transactionId: TXID, index: 0, state: poolState,
  tokenUtxo: { transactionId: TXID, index: 1, value: 50_000_000n },
};

describe('HLK-L12 pool swap build guards (recipient-bound witness must be past the covenant inputs)', () => {
  const buyQ = quotePoolCpBuy(poolState, poolParams, 50n * 1_000_000n)!;
  const sellQ = quotePoolCpSell(poolState, poolParams, 500000n)!;
  const traderTokens = [{ transactionId: TXID, index: 2, value: 1000n, state: addressPresenceOwned(B32(3), 500000n) }];

  it('swapKasForToken refuses witness < 2 (no merges) on a recipient-bound schema', () => {
    expect(() => buildPoolV3SwapKasForToken(k, poolTpl(true), tokenTpl, poolParams, poolUtxo, B32(0xee), B32(3), buyQ, [], 1))
      .toThrow(/recipient-bound schema/);
  });
  it('swapTokenForKas refuses witness < 2 + traderTokens.length on a recipient-bound schema', () => {
    expect(() => buildPoolV3SwapTokenForKas(k, poolTpl(true), tokenTpl, poolParams, poolUtxo, B32(0xee), B32(3), traderTokens, sellQ, 2))
      .toThrow(/recipient-bound schema/);
  });
  it('the guards are schema-gated: a legacy template with the same stale witness reaches the build (and dies on the dummy script, not the guard)', () => {
    // Legacy path: no HLK-L12 guard fires; the empty dummy script fails later, at materialization — proving
    // the throw the recipient-bound cases saw came from the guard, not from the fixtures.
    expect(() => buildPoolV3SwapTokenForKas(k, poolTpl(false), tokenTpl, poolParams, poolUtxo, B32(0xee), B32(3), traderTokens, sellQ, 2))
      .toThrow(/state layout/);
  });
});

describe('HLK-L12 pool LP build guards', () => {
  it('addLiquidity refuses witness < 4 on a recipient-bound schema', () => {
    const q = quoteAddLiquidity(poolState, 79n);
    const lpDeposit = { transactionId: TXID, index: 3, value: 1000n, state: addressPresenceOwned(B32(3), q.dToken) };
    const lpInv = { transactionId: TXID, index: 4, value: 1000n, amount: MAX_SHARES - poolState.totalShares };
    expect(() => buildAddLiquidity(k, poolTpl(true, true), tokenTpl, poolUtxo, lpInv, B32(0xee), lpDeposit, B32(3), q, 3, { lpBindVerified: true }))
      .toThrow(/recipient-bound schema/);
  });
  it('removeLiquidity refuses witness < 4 canonical / < 3 archived on a recipient-bound schema', () => {
    const q = quoteRemoveLiquidity(poolState, poolParams, 10n);
    const lpShares = { transactionId: TXID, index: 3, value: 1000n, state: addressPresenceOwned(B32(3), q.dShares) };
    const lpInventory = { transactionId: TXID, index: 4, value: 1000n, amount: MAX_SHARES - poolState.totalShares };
    expect(() => buildRemoveLiquidity(k, poolTpl(true, true), tokenTpl, poolUtxo, lpShares, B32(0xee), B32(3), q, 3, { lpInventory }))
      .toThrow(/recipient-bound schema/);
    expect(() => buildRemoveLiquidity(k, poolTpl(true, false), tokenTpl, poolUtxo, lpShares, B32(0xee), B32(3), q, 2))
      .toThrow(/recipient-bound schema/);
  });
});

describe('HLK-L07 zero-payout redemption (allowZeroPayout)', () => {
  // A shares-heavy pool (reserves ≪ totalShares) where a small dShares floors BOTH payouts to zero.
  const heavy: PoolCpState = { kasReserve: 1000n, tokenReserve: 2000n, tokenCovid: B32(0xab), totalShares: 1_000_000n, lpCovid: B32(0xdd) };
  const heavyParams = { ...poolParams, lockedShares: 1000n };
  const tiny = removeMinDShares(heavy) - 1n;   // 499: dKas = ⌊1000·499/1e6⌋ = 0, dToken = ⌊2000·499/1e6⌋ = 0

  it('legacy contract unchanged: both-sides-zero still throws, below-min still snaps to 0', () => {
    expect(tiny).toBeGreaterThan(0n);
    expect(() => quoteRemoveLiquidity(heavy, heavyParams, tiny)).toThrow(/both payout sides/);
    expect(snapRemoveDShares(heavy, tiny)).toBe(0n);
  });
  it('with allowZeroPayout (tpl.zeroRemoveAllowed) the zero-payout burn quotes and snaps through', () => {
    const q = quoteRemoveLiquidity(heavy, heavyParams, tiny, { allowZeroPayout: true });
    expect(q.dKas).toBe(0n);
    expect(q.dToken).toBe(0n);
    expect(q.newShares).toBe(heavy.totalShares - tiny);
    expect(snapRemoveDShares(heavy, tiny, { allowZeroPayout: true })).toBe(tiny);
  });
});

// --- curve fixtures ------------------------------------------------------------------------------
const curveTpl = (recipientBound: boolean): CpTemplate => ({
  script: new Uint8Array(0), stateStart: 0, recipientBound,
  params: {
    creatorFeeOwner: B32(1), platformFeeOwner: B32(2),
    vKas: 5000n, graduationKas: 5000000000n, creatorFeeBps: 70n, platformFeeBps: 30n, graduationFeeBps: 500n,
  },
});
const curveUtxo = { transactionId: TXID, index: 0, realKas: 10_000_000n, state: { graduated: false, tokenCovid: B32(0xab), tokenReserve: 400000n } };
const curveInv = { transactionId: TXID, index: 1, value: 1000n, amount: 400000n };

describe('HLK-L04 curve buy/sell build guards', () => {
  const seller = { transactionId: TXID, index: 2, value: 1000n, state: addressPresenceOwned(B32(4), 500n) };

  it('buy refuses witness < 2 + mergeTokens.length on a recipient-bound schema', () => {
    expect(() => buildCpBuy(k, curveTpl(true), tokenTpl, curveUtxo, curveInv, B32(0xcc), B32(3), 1_000_000n, 99n, [], 1))
      .toThrow(/HLK-L04/);
  });
  it('sell refuses witness < 2 + sellerTokens.length on a recipient-bound schema', () => {
    expect(() => buildCpSell(k, curveTpl(true), tokenTpl, curveUtxo, [seller], curveInv, B32(0xcc), B32(4), 160n, 2_000_000n, 2))
      .toThrow(/HLK-L04/);
  });
  it('HLK-L05: a full drain (kasOut == realKas) is refused on EVERY schema — consensus rejects TxOutZero', () => {
    expect(() => buildCpSell(k, curveTpl(false), tokenTpl, curveUtxo, [seller], curveInv, B32(0xcc), B32(4), 160n, curveUtxo.realKas, 3))
      .toThrow(/invalid kasOut/);
  });
});
