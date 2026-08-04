// Covenant UTXO selection — the contract for finding a KCC-20 balance on chain before you spend it.
//
// READ THIS BEFORE WRITING YOUR OWN SELECTION. The obvious implementation is wrong, it is wrong in a way that
// looks correct for months, and it took KRON's own frontend out of service on every token an attacker chose.
//
// ─── THE RULE ─────────────────────────────────────────────────────────────────────────────────────────────
// A KCC-20 UTXO's native KAS value (the sompi riding on the output) is NOT part of its identity and is NOT
// predictable. Never select on it, and never assume it when you build a spend. Read it from the UTXO you are
// about to spend.
//
// ─── WHY ──────────────────────────────────────────────────────────────────────────────────────────────────
// `kcc20.sil` enforces token-AMOUNT conservation and says nothing whatsoever about output values — on EVERY
// schema, including current. On the schemas most live tokens run, the curve and pool covenants pin only their
// OWN KAS continuation and their fee legs, so the covenant-owned token output's value is chosen freely by
// whoever builds the transaction. From the value-continuation schema onward they additionally enforce
// `out.value >= in.value` on that output — which stops SHAVING but deliberately still permits PADDING, so the
// value is still not a constant you may assume. Both directions are proven against the compiled covenants in
// the Silverscript VM (KRON repo: `covenants/native/tools/poc-token-output-value-continuation.mjs`, which runs
// the archived pre-fix sources and the current ones side by side).
//
// So a UTXO you did not create may legitimately carry any value at all:
//   • a stranger can shave it (bounded near 0.45 KAS by KIP-9 storage mass) or pad it (1 sompi, no bound);
//   • ANOTHER IMPLEMENTATION can simply use a different default and mean nothing by it. That is not
//     hypothetical: this SDK itself defaulted an unset `tokenDust` to `1000n` before KRN-SDK-DUST (0.13.3).
//
// A selector that matches `value === COVENANT_DUST` therefore fails to find a perfectly valid UTXO, and a
// builder that assumes `COVENANT_DUST` for an input builds a transaction that does not balance and that
// consensus rejects. Neither failure needs an attacker — a second implementation is enough.
//
// ─── WHAT AUTHENTICATES A BALANCE INSTEAD ─────────────────────────────────────────────────────────────────
// The P2SH address a kcc20 balance sits at is derived from its MATERIALIZED state — owner, identifier type,
// amount and the minter flag are all inside the script that hashes to the address. Address + covenant id
// already prove you have the exact balance you meant. Uniqueness (`matches.length === 1`) is the real guard;
// the value never authenticated anything. On chain, the covenants re-prove identity independently
// (`requireOwnTokenReserveInput` pins covid + template + owner + amount on the input it spends).
//
// ─── HOW TO USE ───────────────────────────────────────────────────────────────────────────────────────────
//   const hit = selectCovenantTokenUtxo(entriesAtDerivedAddress, tokenCovid);
//   if (!hit) throw new Error('not found or ambiguous');   // fail closed — do NOT fall back to a guess
//   const inputValue = BigInt(hit.amount);                 // the REAL carrier value; feed this to the builder
//   // and size funding for the top-up you are about to emit:
//   const extra = carrierShortfall(inputValue);            // 0 when the piece is already >= COVENANT_DUST
//
// READ whatever is actually there. For a COVENANT-OWNED continuation output (curve inventory, pool token
// reserve, pool L inventory) emit `continuationValue(COVENANT_DUST, inputValue)` — NOT a bare constant, or the
// value-continuation covenants reject your transaction against a padded reserve and wedge the token. For every
// other output emit COVENANT_DUST; that is what restores the invariant and keeps storage mass sane for
// everyone after you, and the difference is funded by whoever spends next — bounded, paid once, permanent.
import { COVENANT_DUST } from './spend.js';

export { COVENANT_DUST };

/** Extra KAS a spender must bring because a token INPUT carries less than the COVENANT_DUST it is re-emitted
 *  at. Returns 0 for inputs already at or above it — an over-funded piece needs no adjustment, its surplus
 *  simply lands in change. Add this to your funding selection or the change output can go negative. */
export const carrierShortfall = (...inputValues: bigint[]): bigint =>
  inputValues.reduce((sum, v) => sum + (v < COVENANT_DUST ? COVENANT_DUST - v : 0n), 0n);

/** The native KAS a token piece carries. `value` should come from the chain entry you verified; the fallback
 *  exists only so an unverified piece degrades to the emit-side constant instead of throwing. Prefer passing
 *  pieces whose value you actually read. */
export const carrierOf = (u: { value?: bigint }): bigint => u.value ?? COVENANT_DUST;

/** The native value a covenant-owned CONTINUATION output must carry: at least the dust we normally emit, and
 *  never less than the input it continues.
 *
 *  REQUIRED from the value-continuation schema onward. Those covenants enforce `out.value >= in.value` on the
 *  curve inventory / pool token reserve / pool L inventory, so emitting a bare `COVENANT_DUST` against an
 *  OVER-funded input is REJECTED by consensus — and because that output is the token's only reserve, the
 *  rejection wedges the token permanently. Padding an input above the dust is legal, self-funded and harmless;
 *  this function is what keeps it harmless.
 *
 *  Safe on pre-continuation tokens too: those covenants constrain no output value, and carrying the larger
 *  value forward is what an honest spender would do anyway. So apply it unconditionally — do NOT branch on
 *  schema. */
export const continuationValue = (dust: bigint, inputValue: bigint): bigint => (inputValue > dust ? inputValue : dust);

/** Normalize a provider-supplied covenant id to lowercase 64-hex, or null if it isn't one. */
export const normalizedCovenantId = (value: unknown): string | null => {
  const text = String((value as any)?.toString?.() ?? value ?? '').trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
};

/** Select one covenant UTXO by lineage, optionally also by an exact native value.
 *
 *  Pass `expectedAmount` ONLY where the chain pins that value and you are re-checking a real invariant — the
 *  curve/pool KAS continuation (pinned by the covenant, and the thing that discriminates between candidate
 *  reserve states), or a `batchBuy` buyer output (`curve_cp.sil` requires `== ORDER_TOKEN_DUST`). For every
 *  KCC-20 token balance pass `null`, or use `selectCovenantTokenUtxo`.
 *
 *  Fails closed: a wrong/malformed covid, no match, or MORE THAN ONE match all return null. */
export function selectCovenantUtxo(entries: any[], expectedCovid: string, expectedAmount: bigint | null): any | null {
  const covid = normalizedCovenantId(expectedCovid);
  if (!covid) return null;
  const matches = entries.filter((e) => e.covenantId === covid && (expectedAmount === null || BigInt(e.amount) === expectedAmount));
  return matches.length === 1 ? matches[0] : null;
}

/** Same fail-closed check when you already know the exact outpoint. */
export function selectCovenantOutpoint(entries: any[], expectedOutpoint: { transactionId: string; index: number }, expectedCovid: string, expectedAmount: bigint | null): any | null {
  const txid = normalizedCovenantId(expectedOutpoint.transactionId);
  const covid = normalizedCovenantId(expectedCovid);
  if (!txid || !covid || !Number.isSafeInteger(expectedOutpoint.index) || expectedOutpoint.index < 0) return null;
  const matches = entries.filter((e) => normalizedCovenantId(e.outpoint?.transactionId) === txid
    && Number(e.outpoint?.index) === expectedOutpoint.index
    && e.covenantId === covid
    && (expectedAmount === null || BigInt(e.amount) === expectedAmount));
  return matches.length === 1 ? matches[0] : null;
}

/** THE ONE TO USE for a KCC-20 balance — a curve inventory, a pool token reserve, a pool LP inventory, or a
 *  holder's own presence-owned piece. Selects by lineage only. Take the value from the returned entry. */
export function selectCovenantTokenUtxo(entries: any[], expectedCovid: string): any | null {
  return selectCovenantUtxo(entries, expectedCovid, null);
}

/** Outpoint-pinned variant — txid + index + covid already settle identity completely. */
export function selectCovenantTokenOutpoint(entries: any[], expectedOutpoint: { transactionId: string; index: number }, expectedCovid: string): any | null {
  return selectCovenantOutpoint(entries, expectedOutpoint, expectedCovid, null);
}
