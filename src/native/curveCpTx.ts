// Virtual-reserve constant-product curve builder — builds transactions against an ALREADY-DEPLOYED curve_cp
// covenant instance (buy/sell/graduate). Curve state is {graduated, tokenCovid, tokenReserve} (realKas = the
// curve UTXO value; tokenReserve = the committed token inventory, authoritative in state and kept in sync with
// the C-owned inventory UTXO the curve also holds).
//
//   buy       — kasIn into the reserve, tokenOut from inventory to the buyer (presence-owned), fee split. The
//               bought tokens MERGE with any existing buyer holdings passed in `mergeTokens` into ONE output.
//   sell      — the seller folds `tokenIn` from their piece(s) into inventory, refund kasOut; the unsold
//               remainder returns as ONE presence-owned change output (fractional; no pre-split needed).
//   graduate  — lock the curve, seed amm_pool_cp_v3 with the post-fee reserve + leftover inventory.
//
// State region (verify: silverc state_layout {start:1,len:44}): off 1: 0x01 <graduated:1> 0x20 <tokenCovid:32>
//   0x08 <tokenReserve:8 LE>. tokenReserve is the AUTHORITATIVE token inventory committed to state (this is the
//   reserve-spoof hardening: buy/sell/graduate read the reserve from state, not from an attacker-chosen input).
// No top-level SDK import (only `import type`) — caller passes the loaded WASM namespace `k`. Callers need a
// full `CpTemplate`, which this package does not compile (no covenant compiler ships here — see README): get it
// from the KRON backend's `POST /api/native/cp-template`, shaped by `client.fetchCpTemplates()` (or
// `client.shapeCpTemplates()` if you own the HTTP call). An indexer's raw `redeemScriptHex` is NOT enough: it
// gives the script bytes alone, while `CpTemplate` also needs `params` (fee owners, vKas, graduationKas, fee
// bps, dev-fund leg), and the ABI discriminators cannot be recovered from the compiled bytes. On that response
// the `params` echo is TOP-LEVEL (`response.params`) — NOT nested per template — and it is the same echo that
// hydrates `params.devFundOwner` / `params.devFundBps`: append that leg on a schema without it and the fee is
// silently donated; omit it on a schema that has it and the covenant rejects the tx.
import type { Kaspa } from '../wasm/kaspa.types.js';
import { continuationValue } from './covenantSelect.js';
import { SigScriptBuilder, int8LE } from './sigscript.js';
import { COVENANT_DUST } from './spend.js';
import {
  type Kcc20State,
  type Kcc20Template,
  materializeKcc20Script,
  kcc20Spk,
  covenantIdOwned,
  addressPresenceOwned,
  pushKcc20StateScalar,
  transferSigScript,
} from './kcc20Tx.js';
import { genesisCovenantId, covidToBytes } from './genesis.js';
import { resolveRecipientBound } from './abiGuard.js';
import { materializePoolCpScript, type PoolCpTemplate } from './poolCpTx.js';
import { FEE_OUT_MIN, MAX_KAS } from '../curve/cpCurve.js';
import type { CovenantSpend, CovInput, CovOutput } from './spend.js';

type K = Kaspa;
type Spk = any;

export const SCALE = 1_000_000n; // 1e6 sompi = 0.01 KAS (matches curve_cp.sil)
// Fee outputs padded to FEE_OUT_MIN (cpCurve) — a sub-dust output blows KIP-9 storage mass past the 500k cap.
const padFee = (f: bigint) => (f > FEE_OUT_MIN ? f : FEE_OUT_MIN);
export const SELECTOR = { init: 0, buy: 1, sell: 2, graduate: 3, initVested: 4 } as const;
const ZERO32 = new Uint8Array(32);

/** Fixed per-token curve parameters (baked into the redeem script by silverc). */
export type CpParams = {
  creatorFeeOwner: Uint8Array;   // 32-byte x-only pubkey (P2PK)
  platformFeeOwner: Uint8Array;  // 32-byte x-only pubkey (P2PK)
  vKas: bigint;                  // virtual KAS reserve, SCALE units
  graduationKas: bigint;         // raised-KAS target (sompi)
  creatorFeeBps: bigint;
  platformFeeBps: bigint;
  graduationFeeBps: bigint;
  // Dual-ABI switch: PRESENT only on dev-fund-schema tokens (hydrated from the compiler's params echo). When
  // set, buy/sell MUST append the third fee output (buy[5]/sell[4]) or the covenant rejects the tx; when absent
  // (old-pinned tokens) appending it would silently donate the leg — never default it.
  devFundOwner?: Uint8Array;     // 32-byte x-only pubkey (P2PK)
  devFundBps?: bigint;
};
/** The dev-fund leg baked into this template, or null for old-ABI (two-fee) tokens. */
const devFundLeg = (p: CpParams): { owner: Uint8Array; bps: bigint } | null =>
  p.devFundOwner && p.devFundBps != null ? { owner: p.devFundOwner, bps: p.devFundBps } : null;
export type CpTemplate = {
  script: Uint8Array; stateStart: number; params: CpParams;
  /** Dual-ABI (HLK-L04): true ⇒ buy/sell take two appended witness args (recipientWitness,
   *  recipientIdentifier) and bind the buyer/change output owner to a co-signed P2PK input. Absent/false ⇒
   *  legacy 4-arg form. The cp-template response echoes it as `tradeRecipientBound` — hydrate it with
   *  `client.fetchCpTemplates()` or `client.shapeCpTemplates()`, never by hand.
   *
   *  NEVER default it true: pushing the extra args on a legacy schema corrupts the covenant's arg stack.
   *  Leaving it UNSET on a recipient-bound schema is the opposite hazard — the builder emits a signature
   *  script two stack items short and the node rejects the tx with "failed to verify the signature script:
   *  ... pick at an invalid location". An unset flag therefore warns once per builder; set it explicitly to
   *  `false` to assert a legacy schema. */
  recipientBound?: boolean;
};
export type CpCurveState = { graduated: boolean; tokenCovid: Uint8Array; tokenReserve: bigint };
/** The live curve UTXO. `realKas` (sompi) = its value = KAS raised. */
export type CpCurveUtxo = { transactionId: string; index: number; realKas: bigint; state: CpCurveState };
/** The curve's C-owned token inventory UTXO (covid A). `amount` = tokens remaining. */
export type CpInventoryUtxo = { transactionId: string; index: number; value: bigint; amount: bigint };

// --- state splice (off 1, 44 bytes: graduated + tokenCovid + tokenReserve) ---------------------
export function materializeCpScript(tpl: CpTemplate, state: CpCurveState): Uint8Array {
  const s = tpl.stateStart;
  const t = tpl.script;
  if (t[s] !== 0x01 || t[s + 2] !== 0x20 || t[s + 35] !== 0x08) {
    throw new Error('curve_cp template has an unexpected state layout (expected push1 graduated / push32 tokenCovid / push8 tokenReserve)');
  }
  if (state.tokenCovid.length !== 32) throw new Error('tokenCovid must be 32 bytes');
  if (state.tokenReserve < 0n) throw new Error('tokenReserve must be non-negative');
  const out = t.slice();
  out[s] = 0x01;
  out[s + 1] = state.graduated ? 1 : 0;
  out[s + 2] = 0x20;
  out.set(state.tokenCovid, s + 3);
  out[s + 35] = 0x08;
  out.set(int8LE(state.tokenReserve), s + 36);
  return out;
}

export const cpSpk = (k: K, redeem: Uint8Array): Spk => (k as any).payToScriptHashScript(redeem);
export const cpSpkForState = (k: K, tpl: CpTemplate, state: CpCurveState): Spk => cpSpk(k, materializeCpScript(tpl, state));
export function cpAddress(k: K, tpl: CpTemplate, state: CpCurveState, network: string): string {
  return (k as any).addressFromScriptPublicKey(cpSpkForState(k, tpl, state), network)?.toString() ?? '';
}

/** Fee output scriptPublicKey: P2PK (`<32-byte pubkey> OP_CHECKSIG`). */
export function p2pkSpk(k: K, pubkey: Uint8Array): Spk {
  const sb = new (k as any).ScriptBuilder();
  sb.addData(pubkey).addOp(172);
  return new (k as any).ScriptPublicKey(0, sb.drain());
}

// --- curve-input signature scripts -------------------------------------------------------------
function buySig(k: K, tpl: CpTemplate, redeem: Uint8Array, kasIn: bigint, tokenOut: bigint, inventoryOut: Kcc20State, buyerOut: Kcc20State, buyerWitness: number, buyerIdentifier: Uint8Array): string {
  const b = new SigScriptBuilder(k).int(kasIn).int(tokenOut);
  pushKcc20StateScalar(b, inventoryOut);
  pushKcc20StateScalar(b, buyerOut);
  // HLK-L04: recipient-bound schemas take (buyerWitness, buyerIdentifier); pushing them on a legacy schema
  // would corrupt the arg stack, so gate on the discriminator.
  if (tpl.recipientBound) b.int(BigInt(buyerWitness)).data(buyerIdentifier);
  return b.selector(SELECTOR.buy).redeem(redeem).drain();
}
// single-token sell: pushes traderChangeOut too (even on a full sell — the covenant only validates it when a
// 2nd covid-A output exists; otherwise it's an ignored placeholder).
function sellSig(k: K, tpl: CpTemplate, redeem: Uint8Array, tokenIn: bigint, kasOut: bigint, inventoryOut: Kcc20State, traderChangeOut: Kcc20State, sellerWitness: number, sellerIdentifier: Uint8Array): string {
  const b = new SigScriptBuilder(k).int(tokenIn).int(kasOut);
  pushKcc20StateScalar(b, inventoryOut);
  pushKcc20StateScalar(b, traderChangeOut);
  if (tpl.recipientBound) b.int(BigInt(sellerWitness)).data(sellerIdentifier);   // HLK-L04 — see buySig
  return b.selector(SELECTOR.sell).redeem(redeem).drain();
}
// graduate: the PoolState struct has five fields (kasReserve, tokenReserve, tokenCovid, totalShares, lpCovid)
// — push all five in declared order.
function graduateSigV2(k: K, redeem: Uint8Array, pool: { kasReserve: bigint; tokenReserve: bigint; tokenCovid: Uint8Array; totalShares: bigint; lpCovid: Uint8Array }, poolTokens: Kcc20State): string {
  const b = new SigScriptBuilder(k).int(pool.kasReserve).int(pool.tokenReserve).data(pool.tokenCovid).int(pool.totalShares).data(pool.lpCovid);
  pushKcc20StateScalar(b, poolTokens);
  return b.selector(SELECTOR.graduate).redeem(redeem).drain();
}

// --- buy (MERGE): kasIn into reserve, tokenOut from inventory; the bought tokens MERGE with any EXISTING holdings
// the buyer passes in `mergeTokens` into ONE presence-owned output — so a buy never fragments. `presenceWitnessIdx`
// = the tx input index of a co-present P2PK input at the buyer's address (only needed when merging).
export function buildCpBuy(
  k: K,
  tpl: CpTemplate,
  tokenTpl: Kcc20Template,
  utxo: CpCurveUtxo,
  inventory: CpInventoryUtxo,
  curveCovid: Uint8Array,
  buyerPubkey: Uint8Array,
  kasIn: bigint,
  tokenOut: bigint,
  mergeTokens: { transactionId: string; index: number; value: bigint; state: Kcc20State }[] = [],
  presenceWitnessIdx = 0,
  opts: { tokenDust?: bigint } = {},
): CovenantSpend {
  if (utxo.state.graduated) throw new Error('curve has graduated — buys are locked');
  if (kasIn <= 0n || kasIn % SCALE !== 0n) throw new Error('kasIn must be a positive multiple of SCALE (0.01 KAS)');
  if (tokenOut <= 0n || tokenOut >= inventory.amount) throw new Error('invalid tokenOut');
  if (inventory.amount !== utxo.state.tokenReserve) throw new Error('inventory.amount must equal the curve\'s committed tokenReserve');
  // Merge tokens are presence-owned: their kcc20 witness MUST be a co-present signed P2PK funding input.
  // Input 0 is the curve covenant (no signature), so the default 0 would fail the on-chain presence check.
  if (mergeTokens.length > 0 && presenceWitnessIdx === 0) throw new Error('presenceWitnessIdx must be set to a co-present signed P2PK funding input when mergeTokens is non-empty (input 0 is the curve covenant and carries no signature)');
  // An UNSET discriminator silently selects the legacy ABI — right for legacy schemas, a guaranteed
  // "pick at an invalid location" rejection on a recipient-bound one. Warn once; see ./abiGuard.ts.
  resolveRecipientBound(tpl.recipientBound, 'buildCpBuy', 'tradeRecipientBound');
  // HLK-L04: on a recipient-bound schema the covenant demands the buyer co-sign a P2PK input carrying the
  // buyerOut key. Inputs [0]=curve, [1]=inventory, [2..]=merged tokens are all covenant inputs, so a witness
  // pointing at any of them is a stale caller — fail at build time instead of a VM rejection.
  if (tpl.recipientBound && presenceWitnessIdx < 2 + mergeTokens.length) {
    throw new Error('recipient-bound schema: presenceWitnessIdx must point at the buyer\'s own P2PK funding input (HLK-L04)');
  }
  const dust = opts.tokenDust ?? COVENANT_DUST;
  const curveCovidHex = hexOf(curveCovid);
  const tokenCovidHex = hexOf(utxo.state.tokenCovid);
  const newKas = utxo.realKas + kasIn;
  // Overbuy allowed: a buy may exceed graduationKas (excess seeds the LP at graduation). Only MAX_KAS caps it.
  if (newKas > MAX_KAS) throw new Error('buy exceeds the curve max raise (9,000,000 TKAS)');
  const newToken = inventory.amount - tokenOut;
  const creatorFee = (kasIn * tpl.params.creatorFeeBps) / 10000n;
  const platformFee = (kasIn * tpl.params.platformFeeBps) / 10000n;
  const devFund = devFundLeg(tpl.params);
  const devFundFee = devFund ? (kasIn * devFund.bps) / 10000n : 0n;
  const mergeSum = mergeTokens.reduce((s, t) => s + t.state.amount, 0n);

  const inventoryOut = covenantIdOwned(curveCovid, newToken, false);
  const buyerOut = addressPresenceOwned(buyerPubkey, tokenOut + mergeSum); // bought + merged existing → ONE UTXO
  const curRedeem = materializeCpScript(tpl, utxo.state);
  const newCurveRedeem = materializeCpScript(tpl, { graduated: false, tokenCovid: utxo.state.tokenCovid, tokenReserve: newToken });
  const invRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(curveCovid, inventory.amount, false));
  const invOutRedeem = materializeKcc20Script(tokenTpl, inventoryOut);
  const buyerRedeem = materializeKcc20Script(tokenTpl, buyerOut);
  // covid-A inputs in tx order: inventory (witness = curve input 0), then each merged existing token (presence → P2PK).
  const witnesses = [0, ...mergeTokens.map(() => presenceWitnessIdx)];
  const newStates = [inventoryOut, buyerOut];

  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: utxo.realKas, scriptPublicKey: cpSpk(k, curRedeem), signatureScript: buySig(k, tpl, curRedeem, kasIn, tokenOut, inventoryOut, buyerOut, presenceWitnessIdx, buyerPubkey), redeem: curRedeem, role: 'curve' },
    // inventory (covid A, C-owned) spent via kcc20 transfer; the C-owned input is authorized by the curve (input 0)
    { transactionId: inventory.transactionId, index: inventory.index, value: inventory.value, scriptPublicKey: kcc20Spk(k, invRedeem), signatureScript: transferSigScript(k, invRedeem, newStates, witnesses), redeem: invRedeem, role: 'inventory' },
    ...mergeTokens.map((mt) => {
      const r = materializeKcc20Script(tokenTpl, mt.state);
      return { transactionId: mt.transactionId, index: mt.index, value: mt.value, scriptPublicKey: kcc20Spk(k, r), signatureScript: transferSigScript(k, r, newStates, witnesses), redeem: r, role: 'buyerToken' as const };
    }),
  ];
  const outputs: CovOutput[] = [
    { value: newKas, scriptPublicKey: cpSpk(k, newCurveRedeem), role: 'curve', binding: { covid: curveCovidHex, authorizingInput: 0 } },
    { value: continuationValue(dust, inventory.value), scriptPublicKey: kcc20Spk(k, invOutRedeem), role: 'inventory', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
    { value: dust, scriptPublicKey: kcc20Spk(k, buyerRedeem), role: 'recipient', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
    { value: padFee(creatorFee), scriptPublicKey: p2pkSpk(k, tpl.params.creatorFeeOwner), role: 'creatorFee' },
    { value: padFee(platformFee), scriptPublicKey: p2pkSpk(k, tpl.params.platformFeeOwner), role: 'platformFee' },
  ];
  // BUY_DEV_FEE_OUT = 5 is a FIXED covenant index — on a dev-fund token the leg is required, not optional.
  if (devFund) outputs.push({ value: padFee(devFundFee), scriptPublicKey: p2pkSpk(k, devFund.owner), role: 'devFundFee' });
  return { kind: 'buy', inputs, outputs, economics: { kasIn, tokenOut, creatorFee, platformFee, devFundFee, newRealKas: newKas, newTokenReserve: newToken, merged: mergeSum }, covids: { tokenCovid: tokenCovidHex } };
}

// --- sell (single-token, FRACTIONAL): fold `tokenIn` from the seller's piece(s), refund kasOut, return the
// unsold remainder as ONE presence-owned change output (LAST) — no pre-split. Inputs: [curve(0), inventory(1),
// seller1(2)…sellerN]. `presenceWitnessIdx` = the tx index of a co-present P2PK input at the seller's address the
// wallet signs (also the presence witness that authorizes the address-owned seller tokens). covid-A outputs:
// [inventory(0), OPTIONAL change(1)]. kcc20 conservation forces change == Σ(seller inputs) − tokenIn.
export function buildCpSell(
  k: K,
  tpl: CpTemplate,
  tokenTpl: Kcc20Template,
  utxo: CpCurveUtxo,
  sellerTokens: { transactionId: string; index: number; value: bigint; state: Kcc20State }[],
  inventory: CpInventoryUtxo,
  curveCovid: Uint8Array,
  traderPubkey: Uint8Array,
  tokenIn: bigint,
  kasOut: bigint,
  presenceWitnessIdx: number,
  opts: { tokenDust?: bigint } = {},
): CovenantSpend {
  if (utxo.state.graduated) throw new Error('curve has graduated — sells are locked');
  if (sellerTokens.length < 1) throw new Error('need at least one seller token');
  if (tokenIn <= 0n) throw new Error('tokenIn must be positive');
  // HLK-L05: a full drain (kasOut == realKas) would emit a zero-value curve output, which Kaspa consensus
  // rejects (TxOutZero) on EVERY schema — so the `>=` guard is unconditional, not schema-gated.
  if (kasOut <= 0n || kasOut % SCALE !== 0n || kasOut >= utxo.realKas) throw new Error('invalid kasOut — must leave at least 0.01 KAS in the curve');
  if (inventory.amount !== utxo.state.tokenReserve) throw new Error('inventory.amount must equal the curve\'s committed tokenReserve');
  resolveRecipientBound(tpl.recipientBound, 'buildCpSell', 'tradeRecipientBound');   // see buildCpBuy
  // HLK-L04: see buildCpBuy — inputs [0]=curve, [1]=inventory, [2..]=seller tokens are all covenant inputs.
  if (tpl.recipientBound && presenceWitnessIdx < 2 + sellerTokens.length) {
    throw new Error('recipient-bound schema: presenceWitnessIdx must point at the seller\'s own P2PK funding input (HLK-L04)');
  }
  const dust = opts.tokenDust ?? COVENANT_DUST;
  const curveCovidHex = hexOf(curveCovid);
  const tokenCovidHex = hexOf(utxo.state.tokenCovid);
  const sellerIn = sellerTokens.reduce((s, t) => s + t.state.amount, 0n);
  const change = sellerIn - tokenIn;  // the unsold remainder (kcc20 conservation pins it on-chain)
  if (change < 0n) throw new Error('seller inputs are less than the sell amount');
  const hasChange = change > 0n;
  const newToken = inventory.amount + tokenIn;
  const creatorFee = (kasOut * tpl.params.creatorFeeBps) / 10000n;
  const platformFee = (kasOut * tpl.params.platformFeeBps) / 10000n;
  const devFund = devFundLeg(tpl.params);
  const devFundFee = devFund ? (kasOut * devFund.bps) / 10000n : 0n;

  const inventoryOut = covenantIdOwned(curveCovid, newToken, false);
  const traderChangeOut = addressPresenceOwned(traderPubkey, hasChange ? change : 1n); // dummy(1) on a full sell — covenant ignores it
  const curRedeem = materializeCpScript(tpl, utxo.state);
  const newCurveRedeem = materializeCpScript(tpl, { graduated: false, tokenCovid: utxo.state.tokenCovid, tokenReserve: newToken });
  const invRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(curveCovid, inventory.amount, false));
  const invOutRedeem = materializeKcc20Script(tokenTpl, inventoryOut);
  // covid-A inputs in tx order: inventory (witness = curve input 0), then each seller (presence → its P2PK witness).
  const witnesses = [0, ...sellerTokens.map(() => presenceWitnessIdx)];
  const newStates = hasChange ? [inventoryOut, traderChangeOut] : [inventoryOut];

  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: utxo.realKas, scriptPublicKey: cpSpk(k, curRedeem), signatureScript: sellSig(k, tpl, curRedeem, tokenIn, kasOut, inventoryOut, traderChangeOut, presenceWitnessIdx, traderPubkey), redeem: curRedeem, role: 'curve' },
    { transactionId: inventory.transactionId, index: inventory.index, value: inventory.value, scriptPublicKey: kcc20Spk(k, invRedeem), signatureScript: transferSigScript(k, invRedeem, newStates, witnesses), redeem: invRedeem, role: 'inventory' },
    ...sellerTokens.map((st) => {
      const r = materializeKcc20Script(tokenTpl, st.state);
      return { transactionId: st.transactionId, index: st.index, value: st.value, scriptPublicKey: kcc20Spk(k, r), signatureScript: transferSigScript(k, r, newStates, witnesses), redeem: r, role: 'sellerToken' as const };
    }),
  ];
  const outputs: CovOutput[] = [
    { value: utxo.realKas - kasOut, scriptPublicKey: cpSpk(k, newCurveRedeem), role: 'curve', binding: { covid: curveCovidHex, authorizingInput: 0 } },
    { value: continuationValue(dust, inventory.value), scriptPublicKey: kcc20Spk(k, invOutRedeem), role: 'inventory', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
    { value: padFee(creatorFee), scriptPublicKey: p2pkSpk(k, tpl.params.creatorFeeOwner), role: 'creatorFee' },
    { value: padFee(platformFee), scriptPublicKey: p2pkSpk(k, tpl.params.platformFeeOwner), role: 'platformFee' },
  ];
  // SELL_DEV_FEE_OUT = 4 is a FIXED covenant index — the dev-fund output must precede the optional covid-A
  // change (which the covenant locates by group index, so shifting it to [5] is safe).
  if (devFund) outputs.push({ value: padFee(devFundFee), scriptPublicKey: p2pkSpk(k, devFund.owner), role: 'devFundFee' });
  if (hasChange) outputs.push({ value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, traderChangeOut)), role: 'seller', binding: { covid: tokenCovidHex, authorizingInput: 1 } });
  return { kind: 'sell', inputs, outputs, economics: { tokenIn, kasOut, change, creatorFee, platformFee, devFundFee, newRealKas: utxo.realKas - kasOut, newTokenReserve: newToken }, covids: { tokenCovid: tokenCovidHex } };
}

// --- graduate: lock curve, seed the CP pool (amm_pool_cp_v3) with the 5-field PoolState (locked floor, L unbound) ---
// The curve must have been compiled with the CP pool template + `poolLockedShares` (curve_cp.sil graduate
// requires pool.totalShares == poolLockedShares and pool.lpCovid == ZERO_COVID). The pool's LP-share token L
// is NOT minted here — it's bound post-graduation by the pool's bindLp (buildBindLp), which needs the pool
// live first.
export function buildCpGraduate(
  k: K,
  tpl: CpTemplate,
  tokenTpl: Kcc20Template,
  poolTemplate: PoolCpTemplate,
  utxo: CpCurveUtxo,
  inventory: CpInventoryUtxo,
  curveCovid: Uint8Array,
  poolLockedShares: bigint,
  opts: { lockedCurveValue?: bigint; tokenDust?: bigint } = {},
): CovenantSpend {
  if (utxo.state.graduated) throw new Error('already graduated');
  if (utxo.realKas < tpl.params.graduationKas) throw new Error('reserve has not reached the graduation target');
  if (poolLockedShares < 1n) throw new Error('poolLockedShares must be >= 1');
  if (inventory.amount !== utxo.state.tokenReserve) throw new Error('inventory.amount must equal the curve\'s committed tokenReserve');
  const lockedValue = opts.lockedCurveValue ?? 1000n;
  const dust = opts.tokenDust ?? COVENANT_DUST;
  // poolKas ≈ (1 − gradFeeBps) of the reserve, floored to a whole SCALE step; platform takes the remainder.
  const targetPoolKas = (utxo.realKas * (10000n - tpl.params.graduationFeeBps)) / 10000n;
  const poolKasUnits = targetPoolKas / SCALE;
  const poolKas = poolKasUnits * SCALE;
  const gradFee = utxo.realKas - poolKas;
  const leftover = inventory.amount;

  const A = utxo.state.tokenCovid;
  // pool genesis state: locked floor seeded (totalShares == poolLockedShares), L unbound (lpCovid == ZERO).
  const poolState = { kasReserve: poolKasUnits, tokenReserve: leftover, tokenCovid: A, totalShares: poolLockedShares, lpCovid: ZERO32 };
  const poolRedeem = materializePoolCpScript(poolTemplate, poolState);
  const poolSpkV = (k as any).payToScriptHashScript(poolRedeem);
  const poolCovidHex = genesisCovenantId(k, { transactionId: utxo.transactionId, index: utxo.index }, [
    { index: 1, value: poolKas, scriptPublicKey: poolSpkV },
  ]);
  const poolCovid = covidToBytes(poolCovidHex);
  const poolTokens = covenantIdOwned(poolCovid, leftover, false);
  const poolTokenRedeem = materializeKcc20Script(tokenTpl, poolTokens);

  const curRedeem = materializeCpScript(tpl, utxo.state);
  // graduated husk carries the reserve unchanged (== inventory.amount == the committed reserve at lock time).
  const lockedRedeem = materializeCpScript(tpl, { graduated: true, tokenCovid: A, tokenReserve: inventory.amount });
  const invRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(curveCovid, inventory.amount, false));

  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: utxo.realKas, scriptPublicKey: cpSpk(k, curRedeem), signatureScript: graduateSigV2(k, curRedeem, poolState, poolTokens), redeem: curRedeem, role: 'curve' },
    { transactionId: inventory.transactionId, index: inventory.index, value: inventory.value, scriptPublicKey: kcc20Spk(k, invRedeem), signatureScript: transferSigScript(k, invRedeem, [poolTokens], [0]), redeem: invRedeem, role: 'inventory' },
  ];
  const curveCovidHex = hexOf(curveCovid);
  const tokenCovidHex = hexOf(A);
  const outputs: CovOutput[] = [
    { value: lockedValue, scriptPublicKey: cpSpk(k, lockedRedeem), role: 'curve', binding: { covid: curveCovidHex, authorizingInput: 0 } },
    { value: poolKas, scriptPublicKey: poolSpkV, role: 'pool', binding: { covid: poolCovidHex, authorizingInput: 0 } },
    { value: continuationValue(dust, inventory.value), scriptPublicKey: kcc20Spk(k, poolTokenRedeem), role: 'poolToken', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
    { value: padFee(gradFee), scriptPublicKey: p2pkSpk(k, tpl.params.platformFeeOwner), role: 'gradFee' },
  ];
  return { kind: 'graduate', inputs, outputs, economics: { poolKas, gradFee, leftover, poolLockedShares }, covids: { tokenCovid: hexOf(A), poolCovid: poolCovidHex } };
}

/**
 * Split a presence-owned token UTXO into [sellAmount, change], both still presence-owned by the same holder —
 * a plain conserving kcc20 transfer authorized by a co-present P2PK input at `presenceWitnessIdx`. Lets a
 * holder sell an ARBITRARY amount on covenants that require full-UTXO sells (curve/pool): split, then sell the
 * `sellAmount` piece. No curve/pool involved — just the token covenant.
 * Pass `opts.tokenCovid` (the token's covenant id, hex — `covenantId` from the indexer) so both outputs carry
 * the KIP-20 covenant binding the chain requires; without it the assembled tx fails on-chain.
 */
export function buildSplitToken(
  k: K, tokenTpl: Kcc20Template,
  sellerToken: { transactionId: string; index: number; value: bigint; state: Kcc20State },
  sellAmount: bigint, presenceWitnessIdx: number, opts: { tokenDust?: bigint; tokenCovid?: string } = {},
): CovenantSpend {
  if (!opts.tokenCovid) throw new Error('opts.tokenCovid is required (the token covenant id, hex) — both outputs need the KIP-20 covenant binding or the assembled tx fails on-chain');
  const change = sellerToken.state.amount - sellAmount;
  if (sellAmount <= 0n || change <= 0n) throw new Error('split requires 0 < sellAmount < the UTXO amount');
  const dust = opts.tokenDust ?? COVENANT_DUST;
  const owner = sellerToken.state.ownerIdentifier;
  const out1 = addressPresenceOwned(owner, sellAmount);   // the piece to sell (output 0)
  const out2 = addressPresenceOwned(owner, change);       // the change (output 1)
  const redeem = materializeKcc20Script(tokenTpl, sellerToken.state);
  const binding = opts.tokenCovid ? { covid: opts.tokenCovid, authorizingInput: 0 } : undefined; // ← the seller-token input
  const inputs: CovInput[] = [
    { transactionId: sellerToken.transactionId, index: sellerToken.index, value: sellerToken.value, scriptPublicKey: kcc20Spk(k, redeem), signatureScript: transferSigScript(k, redeem, [out1, out2], [presenceWitnessIdx]), redeem, role: 'sellerToken' },
  ];
  const outputs: CovOutput[] = [
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, out1)), role: 'split', binding },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, out2)), role: 'change', binding },
  ];
  return { kind: 'sell', inputs, outputs, economics: { sellAmount, change }, covids: opts.tokenCovid ? { tokenCovid: opts.tokenCovid } : {} };
}

/**
 * Consolidate several presence-owned token UTXOs (same owner) into ONE — a conserving kcc20 transfer (N covid-A
 * inputs → 1 output) authorized by a single co-present P2PK input at `presenceWitnessIdx`. Lets a holder merge
 * many small buys into one piece so a later sell needs just one (or two) inputs. No curve/pool involved.
 * Pass `opts.tokenCovid` (the token's covenant id, hex) so the merged output carries the KIP-20 covenant
 * binding the chain requires; without it the assembled tx fails on-chain.
 */
export function buildConsolidate(
  k: K, tokenTpl: Kcc20Template,
  tokens: { transactionId: string; index: number; value: bigint; state: Kcc20State }[],
  presenceWitnessIdx: number, opts: { tokenDust?: bigint; tokenCovid?: string } = {},
): CovenantSpend {
  if (!opts.tokenCovid) throw new Error('opts.tokenCovid is required (the token covenant id, hex) — the merged output needs the KIP-20 covenant binding or the assembled tx fails on-chain');
  if (tokens.length < 2) throw new Error('consolidate needs at least 2 UTXOs');
  const dust = opts.tokenDust ?? COVENANT_DUST;
  const owner = tokens[0].state.ownerIdentifier;
  const total = tokens.reduce((s, t) => s + t.state.amount, 0n);
  const merged = addressPresenceOwned(owner, total);
  const newStates = [merged];
  const witnesses = tokens.map(() => presenceWitnessIdx); // every covid-A input authorized by the one P2PK
  const inputs: CovInput[] = tokens.map((t) => {
    const r = materializeKcc20Script(tokenTpl, t.state);
    return { transactionId: t.transactionId, index: t.index, value: t.value, scriptPublicKey: kcc20Spk(k, r), signatureScript: transferSigScript(k, r, newStates, witnesses), redeem: r, role: 'token' };
  });
  const binding = opts.tokenCovid ? { covid: opts.tokenCovid, authorizingInput: 0 } : undefined; // ← the first token input
  const outputs: CovOutput[] = [
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, merged)), role: 'merged', binding },
  ];
  return { kind: 'sell', inputs, outputs, economics: { total }, covids: opts.tokenCovid ? { tokenCovid: opts.tokenCovid } : {} };
}

const hexOf = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
