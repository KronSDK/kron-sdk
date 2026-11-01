// L1 network fee arithmetic for covenant transactions — the ONE place the numbers live.
//
// Why this is its own module (ledger row 2). A covenant spend reveals its whole redeem script in the
// signature script, so a curve trade serialises to ~175 KB and a pool trade to ~64 KB REGARDLESS of trade
// size. The resulting Kaspa network fee is therefore large and essentially size-independent — around 0.42 KAS
// on a plain curve — while the trade panel displayed only the covenant fee legs. A user buying 1 KAS saw a
// total of ~1.6 and was debited ~2.02: the gap is the network fee, disclosed nowhere.
//
// The fee actually CHARGED is computed by `covenantTxV1.estimateFee`, which measures the built transaction.
// The UI has no transaction at quote time, so it estimates from the template size instead. Both now use the
// functions below, so the disclosed number and the charged number cannot drift apart in formula — only in the
// size input, which is exactly the approximation being made and is labelled as such in the UI.
//
// This module is deliberately dependency-free (no SDK, no wasm) so it is unit-testable in plain Node.

export const TRANSIENT_BYTE_TO_MASS_FACTOR = 4n;  // consensus/core/src/constants.rs
export const COMPUTE_MASS_LIMIT = 500_000n;
export const TRANSIENT_MASS_LIMIT = 1_000_000n;
export const FEE_BUFFER_NUM = 6n, FEE_BUFFER_DEN = 5n;   // 1.2× over an exactly-mirrored mass
export const MIN_FEE_SOMPI = 10_000n;
/** The node refuses anything under this feerate, and the builder clamps to it. */
export const MIN_FEE_RATE = 100;

/** Serialized bytes → normalized transient mass: ceil(bytes × 4 × computeLimit / transientLimit). */
export function normalizedTransientMass(serializedBytes: bigint): bigint {
  const raw = serializedBytes * TRANSIENT_BYTE_TO_MASS_FACTOR;
  return (raw * COMPUTE_MASS_LIMIT + TRANSIENT_MASS_LIMIT - 1n) / TRANSIENT_MASS_LIMIT;
}

/** Billable mass × feerate × 1.2, floored at the minimum fee. The exact arithmetic estimateFee applies. */
export function feeForMass(billableMass: bigint, feeRate: number): bigint {
  const rate = BigInt(Math.max(Math.ceil(feeRate), MIN_FEE_RATE));
  const fee = (billableMass * rate * FEE_BUFFER_NUM) / FEE_BUFFER_DEN;
  return fee > MIN_FEE_SOMPI ? fee : MIN_FEE_SOMPI;
}

/**
 * Estimate the L1 fee for a covenant trade from the size of the redeem it reveals — what the UI can know
 * before a transaction exists.
 *
 * Transient mass DOMINATES for the audited family's 64–175 KB redeems (the comment in covenantTxV1 records a
 * mainnet rejection from sizing off compute alone), so estimating from serialized size is the right approximation
 * there. `overhead` covers inputs, outputs and the funding signature beyond the revealed redeem.
 *
 * `computeExtra` = the compute-mass terms beyond the size: output script bytes × 10 + input compute budgets × 100
 * (covenantTxKcc20V1.massDimsV1). The billable mass is then max(size + computeExtra, transient), the builder's own
 * rule. The standard family's ~20–30 KB shapes need it: their budgets outweigh their size (familySizesV1). Without
 * it (0, the audited callers) the result is unchanged: the size alone never beats the transient mass.
 *
 * Returns sompi. Deliberately an OVER-estimate rather than under: showing a user less than they will be
 * debited is the failure being fixed, so erring low would reproduce it.
 */
export function estimateCovenantL1Fee(redeemBytes: number, feeRate: number, overhead = 2_000, computeExtra = 0): bigint {
  const serialized = BigInt(Math.max(0, Math.floor(redeemBytes)) + Math.max(0, Math.floor(overhead)));
  const transient = normalizedTransientMass(serialized);
  const compute = serialized + BigInt(Math.max(0, Math.floor(computeExtra)));
  return feeForMass(compute > transient ? compute : transient, feeRate);
}
