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
// No top-level SDK import (only `import type`) — caller passes the loaded WASM namespace `k`. Callers need
// the target curve's compiled script bytes (`CpTemplate.script`) — read them from your indexer's live UTXO
// data (e.g. the `redeemScriptHex` field), not compiled locally; this package doesn't ship a covenant
// compiler (see README).
import type { Kaspa } from '../wasm/kaspa.types.js';
import { SigScriptBuilder, int8LE } from './sigscript.js';
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
};
export type CpTemplate = { script: Uint8Array; stateStart: number; params: CpParams };
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
function buySig(k: K, redeem: Uint8Array, kasIn: bigint, tokenOut: bigint, inventoryOut: Kcc20State, buyerOut: Kcc20State): string {
  const b = new SigScriptBuilder(k).int(kasIn).int(tokenOut);
  pushKcc20StateScalar(b, inventoryOut);
  pushKcc20StateScalar(b, buyerOut);
  return b.selector(SELECTOR.buy).redeem(redeem).drain();
}
// single-token sell: pushes traderChangeOut too (even on a full sell — the covenant only validates it when a
// 2nd covid-A output exists; otherwise it's an ignored placeholder).
function sellSig(k: K, redeem: Uint8Array, tokenIn: bigint, kasOut: bigint, inventoryOut: Kcc20State, traderChangeOut: Kcc20State): string {
  const b = new SigScriptBuilder(k).int(tokenIn).int(kasOut);
  pushKcc20StateScalar(b, inventoryOut);
  pushKcc20StateScalar(b, traderChangeOut);
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
  const dust = opts.tokenDust ?? 1000n;
  const curveCovidHex = hexOf(curveCovid);
  const tokenCovidHex = hexOf(utxo.state.tokenCovid);
  const newKas = utxo.realKas + kasIn;
  // Overbuy allowed: a buy may exceed graduationKas (excess seeds the LP at graduation). Only MAX_KAS caps it.
  if (newKas > MAX_KAS) throw new Error('buy exceeds the curve max raise (9,000,000 TKAS)');
  const newToken = inventory.amount - tokenOut;
  const creatorFee = (kasIn * tpl.params.creatorFeeBps) / 10000n;
  const platformFee = (kasIn * tpl.params.platformFeeBps) / 10000n;
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
    { transactionId: utxo.transactionId, index: utxo.index, value: utxo.realKas, scriptPublicKey: cpSpk(k, curRedeem), signatureScript: buySig(k, curRedeem, kasIn, tokenOut, inventoryOut, buyerOut), redeem: curRedeem, role: 'curve' },
    // inventory (covid A, C-owned) spent via kcc20 transfer; the C-owned input is authorized by the curve (input 0)
    { transactionId: inventory.transactionId, index: inventory.index, value: inventory.value, scriptPublicKey: kcc20Spk(k, invRedeem), signatureScript: transferSigScript(k, invRedeem, newStates, witnesses), redeem: invRedeem, role: 'inventory' },
    ...mergeTokens.map((mt) => {
      const r = materializeKcc20Script(tokenTpl, mt.state);
      return { transactionId: mt.transactionId, index: mt.index, value: mt.value, scriptPublicKey: kcc20Spk(k, r), signatureScript: transferSigScript(k, r, newStates, witnesses), redeem: r, role: 'buyerToken' as const };
    }),
  ];
  const outputs: CovOutput[] = [
    { value: newKas, scriptPublicKey: cpSpk(k, newCurveRedeem), role: 'curve', binding: { covid: curveCovidHex, authorizingInput: 0 } },
    { value: dust, scriptPublicKey: kcc20Spk(k, invOutRedeem), role: 'inventory', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
    { value: dust, scriptPublicKey: kcc20Spk(k, buyerRedeem), role: 'recipient', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
    { value: padFee(creatorFee), scriptPublicKey: p2pkSpk(k, tpl.params.creatorFeeOwner), role: 'creatorFee' },
    { value: padFee(platformFee), scriptPublicKey: p2pkSpk(k, tpl.params.platformFeeOwner), role: 'platformFee' },
  ];
  return { kind: 'buy', inputs, outputs, economics: { kasIn, tokenOut, creatorFee, platformFee, newRealKas: newKas, newTokenReserve: newToken, merged: mergeSum }, covids: { tokenCovid: tokenCovidHex } };
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
  if (kasOut <= 0n || kasOut % SCALE !== 0n || kasOut > utxo.realKas) throw new Error('invalid kasOut');
  if (inventory.amount !== utxo.state.tokenReserve) throw new Error('inventory.amount must equal the curve\'s committed tokenReserve');
  const dust = opts.tokenDust ?? 1000n;
  const curveCovidHex = hexOf(curveCovid);
  const tokenCovidHex = hexOf(utxo.state.tokenCovid);
  const sellerIn = sellerTokens.reduce((s, t) => s + t.state.amount, 0n);
  const change = sellerIn - tokenIn;  // the unsold remainder (kcc20 conservation pins it on-chain)
  if (change < 0n) throw new Error('seller inputs are less than the sell amount');
  const hasChange = change > 0n;
  const newToken = inventory.amount + tokenIn;
  const creatorFee = (kasOut * tpl.params.creatorFeeBps) / 10000n;
  const platformFee = (kasOut * tpl.params.platformFeeBps) / 10000n;

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
    { transactionId: utxo.transactionId, index: utxo.index, value: utxo.realKas, scriptPublicKey: cpSpk(k, curRedeem), signatureScript: sellSig(k, curRedeem, tokenIn, kasOut, inventoryOut, traderChangeOut), redeem: curRedeem, role: 'curve' },
    { transactionId: inventory.transactionId, index: inventory.index, value: inventory.value, scriptPublicKey: kcc20Spk(k, invRedeem), signatureScript: transferSigScript(k, invRedeem, newStates, witnesses), redeem: invRedeem, role: 'inventory' },
    ...sellerTokens.map((st) => {
      const r = materializeKcc20Script(tokenTpl, st.state);
      return { transactionId: st.transactionId, index: st.index, value: st.value, scriptPublicKey: kcc20Spk(k, r), signatureScript: transferSigScript(k, r, newStates, witnesses), redeem: r, role: 'sellerToken' as const };
    }),
  ];
  const outputs: CovOutput[] = [
    { value: utxo.realKas - kasOut, scriptPublicKey: cpSpk(k, newCurveRedeem), role: 'curve', binding: { covid: curveCovidHex, authorizingInput: 0 } },
    { value: dust, scriptPublicKey: kcc20Spk(k, invOutRedeem), role: 'inventory', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
    { value: padFee(creatorFee), scriptPublicKey: p2pkSpk(k, tpl.params.creatorFeeOwner), role: 'creatorFee' },
    { value: padFee(platformFee), scriptPublicKey: p2pkSpk(k, tpl.params.platformFeeOwner), role: 'platformFee' },
  ];
  if (hasChange) outputs.push({ value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, traderChangeOut)), role: 'seller', binding: { covid: tokenCovidHex, authorizingInput: 1 } });
  return { kind: 'sell', inputs, outputs, economics: { tokenIn, kasOut, change, creatorFee, platformFee, newRealKas: utxo.realKas - kasOut, newTokenReserve: newToken }, covids: { tokenCovid: tokenCovidHex } };
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
  const dust = opts.tokenDust ?? 1000n;
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
    { value: dust, scriptPublicKey: kcc20Spk(k, poolTokenRedeem), role: 'poolToken', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
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
  const change = sellerToken.state.amount - sellAmount;
  if (sellAmount <= 0n || change <= 0n) throw new Error('split requires 0 < sellAmount < the UTXO amount');
  const dust = opts.tokenDust ?? 1000n;
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
  if (tokens.length < 2) throw new Error('consolidate needs at least 2 UTXOs');
  const dust = opts.tokenDust ?? 1000n;
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
