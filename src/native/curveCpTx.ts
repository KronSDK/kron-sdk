// Virtual-reserve constant-product curve builder — builds transactions against an ALREADY-DEPLOYED curve_cp
// covenant instance (buy/sell/graduate). Curve state is just {graduated, tokenCovid} (realKas = the curve
// UTXO value; tokenReserve = a C-owned inventory UTXO).
//
//   buy       — kasIn into the reserve, tokenOut from inventory to the buyer (presence-owned), fee split.
//   sell      — tokenIn from the seller (presence) folds back into inventory, refund kasOut, fee split.
//   graduate  — lock the curve, seed amm_pool_cp_v3 with the post-fee reserve + leftover inventory.
//
// State region (verify: silverc state_layout {start:1,len:35}): off 1: 0x01 <graduated:1> 0x20 <tokenCovid:32>.
// No top-level SDK import (only `import type`) — caller passes the loaded WASM namespace `k`. Callers need
// the target curve's compiled script bytes (`CpTemplate.script`) — read them from your indexer's live UTXO
// data (e.g. the `redeemScriptHex` field), not compiled locally; this package doesn't ship a covenant
// compiler (see README).
import type { Kaspa } from '../wasm/kaspa.types.js';
import { SigScriptBuilder } from './sigscript.js';
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
export type CpCurveState = { graduated: boolean; tokenCovid: Uint8Array };
/** The live curve UTXO. `realKas` (sompi) = its value = KAS raised. */
export type CpCurveUtxo = { transactionId: string; index: number; realKas: bigint; state: CpCurveState };
/** The curve's C-owned token inventory UTXO (covid A). `amount` = tokens remaining. */
export type CpInventoryUtxo = { transactionId: string; index: number; value: bigint; amount: bigint };

// --- state splice (off 1, 35 bytes) ------------------------------------------------------------
export function materializeCpScript(tpl: CpTemplate, state: CpCurveState): Uint8Array {
  const s = tpl.stateStart;
  const t = tpl.script;
  if (t[s] !== 0x01 || t[s + 2] !== 0x20) {
    throw new Error('curve_cp template has an unexpected state layout (expected push1 graduated / push32 tokenCovid)');
  }
  if (state.tokenCovid.length !== 32) throw new Error('tokenCovid must be 32 bytes');
  const out = t.slice();
  out[s] = 0x01;
  out[s + 1] = state.graduated ? 1 : 0;
  out[s + 2] = 0x20;
  out.set(state.tokenCovid, s + 3);
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
function sellSig(k: K, redeem: Uint8Array, tokenIn: bigint, kasOut: bigint, inventoryOut: Kcc20State): string {
  const b = new SigScriptBuilder(k).int(tokenIn).int(kasOut);
  pushKcc20StateScalar(b, inventoryOut);
  return b.selector(SELECTOR.sell).redeem(redeem).drain();
}
// graduate: the PoolState struct has five fields (kasReserve, tokenReserve, tokenCovid, totalShares, lpCovid)
// — push all five in declared order.
function graduateSigV2(k: K, redeem: Uint8Array, pool: { kasReserve: bigint; tokenReserve: bigint; tokenCovid: Uint8Array; totalShares: bigint; lpCovid: Uint8Array }, poolTokens: Kcc20State): string {
  const b = new SigScriptBuilder(k).int(pool.kasReserve).int(pool.tokenReserve).data(pool.tokenCovid).int(pool.totalShares).data(pool.lpCovid);
  pushKcc20StateScalar(b, poolTokens);
  return b.selector(SELECTOR.graduate).redeem(redeem).drain();
}

// --- buy: kasIn into reserve, tokenOut from inventory to buyer (presence-owned) -----------------
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
  opts: { tokenDust?: bigint } = {},
): CovenantSpend {
  if (utxo.state.graduated) throw new Error('curve has graduated — buys are locked');
  if (kasIn <= 0n || kasIn % SCALE !== 0n) throw new Error('kasIn must be a positive multiple of SCALE (0.01 KAS)');
  if (tokenOut <= 0n || tokenOut >= inventory.amount) throw new Error('invalid tokenOut');
  const dust = opts.tokenDust ?? 1000n;
  const newKas = utxo.realKas + kasIn;
  // Overbuy allowed: a buy may exceed graduationKas (excess seeds the LP at graduation). Only MAX_KAS caps it.
  if (newKas > MAX_KAS) throw new Error('buy exceeds the curve max raise (9,000,000 TKAS)');
  const newToken = inventory.amount - tokenOut;
  const creatorFee = (kasIn * tpl.params.creatorFeeBps) / 10000n;
  const platformFee = (kasIn * tpl.params.platformFeeBps) / 10000n;

  const inventoryOut = covenantIdOwned(curveCovid, newToken, false);
  const buyerOut = addressPresenceOwned(buyerPubkey, tokenOut);
  const curRedeem = materializeCpScript(tpl, utxo.state);
  const newCurveRedeem = materializeCpScript(tpl, { graduated: false, tokenCovid: utxo.state.tokenCovid });
  const invRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(curveCovid, inventory.amount, false));
  const invOutRedeem = materializeKcc20Script(tokenTpl, inventoryOut);
  const buyerRedeem = materializeKcc20Script(tokenTpl, buyerOut);

  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: utxo.realKas, scriptPublicKey: cpSpk(k, curRedeem), signatureScript: buySig(k, curRedeem, kasIn, tokenOut, inventoryOut, buyerOut), redeem: curRedeem, role: 'curve' },
    // inventory (covid A, C-owned) spent via kcc20 transfer; the single covid-A input is authorized by the curve (input 0)
    { transactionId: inventory.transactionId, index: inventory.index, value: inventory.value, scriptPublicKey: kcc20Spk(k, invRedeem), signatureScript: transferSigScript(k, invRedeem, [inventoryOut, buyerOut], [0]), redeem: invRedeem, role: 'inventory' },
  ];
  const outputs: CovOutput[] = [
    { value: newKas, scriptPublicKey: cpSpk(k, newCurveRedeem), role: 'curve' },
    { value: dust, scriptPublicKey: kcc20Spk(k, invOutRedeem), role: 'inventory' },
    { value: dust, scriptPublicKey: kcc20Spk(k, buyerRedeem), role: 'recipient' },
    { value: padFee(creatorFee), scriptPublicKey: p2pkSpk(k, tpl.params.creatorFeeOwner), role: 'creatorFee' },
    { value: padFee(platformFee), scriptPublicKey: p2pkSpk(k, tpl.params.platformFeeOwner), role: 'platformFee' },
  ];
  return { kind: 'buy', inputs, outputs, economics: { kasIn, tokenOut, creatorFee, platformFee, newRealKas: newKas, newTokenReserve: newToken }, covids: { tokenCovid: hexOf(utxo.state.tokenCovid) } };
}

// --- sell: seller's tokens (presence) fold into inventory, refund kasOut --------------------------
// `presenceWitnessIdx` = the tx input index of a co-present P2PK input at the seller's address (a funding
// input the wallet signs). The assembly puts covenant inputs [curve,seller,inventory] first, so the flow
// passes covInputs.length (3) and ensures funding input #0 is the seller's P2PK.
export function buildCpSell(
  k: K,
  tpl: CpTemplate,
  tokenTpl: Kcc20Template,
  utxo: CpCurveUtxo,
  sellerToken: { transactionId: string; index: number; value: bigint; state: Kcc20State },
  inventory: CpInventoryUtxo,
  curveCovid: Uint8Array,
  tokenIn: bigint,
  kasOut: bigint,
  presenceWitnessIdx: number,
  opts: { tokenDust?: bigint } = {},
): CovenantSpend {
  if (utxo.state.graduated) throw new Error('curve has graduated — sells are locked');
  if (tokenIn <= 0n || sellerToken.state.amount !== tokenIn) throw new Error('seller token amount must equal tokenIn (full-UTXO sell)');
  if (kasOut <= 0n || kasOut % SCALE !== 0n || kasOut > utxo.realKas) throw new Error('invalid kasOut');
  const dust = opts.tokenDust ?? 1000n;
  const newToken = inventory.amount + tokenIn;
  const creatorFee = (kasOut * tpl.params.creatorFeeBps) / 10000n;
  const platformFee = (kasOut * tpl.params.platformFeeBps) / 10000n;

  const inventoryOut = covenantIdOwned(curveCovid, newToken, false);
  const curRedeem = materializeCpScript(tpl, utxo.state);
  const newCurveRedeem = materializeCpScript(tpl, { graduated: false, tokenCovid: utxo.state.tokenCovid });
  const sellerRedeem = materializeKcc20Script(tokenTpl, sellerToken.state);
  const invRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(curveCovid, inventory.amount, false));
  const invOutRedeem = materializeKcc20Script(tokenTpl, inventoryOut);
  // covid-A inputs in tx order: seller (input 1) then inventory (input 2) → witnesses [sellerAuth, curve]
  const witnesses = [presenceWitnessIdx, 0];
  const newStates = [inventoryOut];

  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: utxo.realKas, scriptPublicKey: cpSpk(k, curRedeem), signatureScript: sellSig(k, curRedeem, tokenIn, kasOut, inventoryOut), redeem: curRedeem, role: 'curve' },
    { transactionId: sellerToken.transactionId, index: sellerToken.index, value: sellerToken.value, scriptPublicKey: kcc20Spk(k, sellerRedeem), signatureScript: transferSigScript(k, sellerRedeem, newStates, witnesses), redeem: sellerRedeem, role: 'sellerToken' },
    { transactionId: inventory.transactionId, index: inventory.index, value: inventory.value, scriptPublicKey: kcc20Spk(k, invRedeem), signatureScript: transferSigScript(k, invRedeem, newStates, witnesses), redeem: invRedeem, role: 'inventory' },
  ];
  const outputs: CovOutput[] = [
    { value: utxo.realKas - kasOut, scriptPublicKey: cpSpk(k, newCurveRedeem), role: 'curve' },
    { value: dust, scriptPublicKey: kcc20Spk(k, invOutRedeem), role: 'inventory' },
    { value: padFee(creatorFee), scriptPublicKey: p2pkSpk(k, tpl.params.creatorFeeOwner), role: 'creatorFee' },
    { value: padFee(platformFee), scriptPublicKey: p2pkSpk(k, tpl.params.platformFeeOwner), role: 'platformFee' },
  ];
  return { kind: 'sell', inputs, outputs, economics: { tokenIn, kasOut, creatorFee, platformFee, newRealKas: utxo.realKas - kasOut, newTokenReserve: newToken }, covids: { tokenCovid: hexOf(utxo.state.tokenCovid) } };
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
  const lockedRedeem = materializeCpScript(tpl, { graduated: true, tokenCovid: A });
  const invRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(curveCovid, inventory.amount, false));

  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: utxo.realKas, scriptPublicKey: cpSpk(k, curRedeem), signatureScript: graduateSigV2(k, curRedeem, poolState, poolTokens), redeem: curRedeem, role: 'curve' },
    { transactionId: inventory.transactionId, index: inventory.index, value: inventory.value, scriptPublicKey: kcc20Spk(k, invRedeem), signatureScript: transferSigScript(k, invRedeem, [poolTokens], [0]), redeem: invRedeem, role: 'inventory' },
  ];
  const outputs: CovOutput[] = [
    { value: lockedValue, scriptPublicKey: cpSpk(k, lockedRedeem), role: 'curve' },
    { value: poolKas, scriptPublicKey: poolSpkV, role: 'pool' },
    { value: dust, scriptPublicKey: kcc20Spk(k, poolTokenRedeem), role: 'poolToken' },
    { value: padFee(gradFee), scriptPublicKey: p2pkSpk(k, tpl.params.platformFeeOwner), role: 'gradFee' },
  ];
  return { kind: 'graduate', inputs, outputs, economics: { poolKas, gradFee, leftover, poolLockedShares }, covids: { tokenCovid: hexOf(A), poolCovid: poolCovidHex } };
}

/**
 * Split a presence-owned token UTXO into [sellAmount, change], both still presence-owned by the same holder —
 * a plain conserving kcc20 transfer authorized by a co-present P2PK input at `presenceWitnessIdx`. Lets a
 * holder sell an ARBITRARY amount on covenants that require full-UTXO sells (curve/pool): split, then sell the
 * `sellAmount` piece. No curve/pool involved — just the token covenant.
 */
export function buildSplitToken(
  k: K, tokenTpl: Kcc20Template,
  sellerToken: { transactionId: string; index: number; value: bigint; state: Kcc20State },
  sellAmount: bigint, presenceWitnessIdx: number, opts: { tokenDust?: bigint } = {},
): CovenantSpend {
  const change = sellerToken.state.amount - sellAmount;
  if (sellAmount <= 0n || change <= 0n) throw new Error('split requires 0 < sellAmount < the UTXO amount');
  const dust = opts.tokenDust ?? 1000n;
  const owner = sellerToken.state.ownerIdentifier;
  const out1 = addressPresenceOwned(owner, sellAmount);   // the piece to sell (output 0)
  const out2 = addressPresenceOwned(owner, change);       // the change (output 1)
  const redeem = materializeKcc20Script(tokenTpl, sellerToken.state);
  const inputs: CovInput[] = [
    { transactionId: sellerToken.transactionId, index: sellerToken.index, value: sellerToken.value, scriptPublicKey: kcc20Spk(k, redeem), signatureScript: transferSigScript(k, redeem, [out1, out2], [presenceWitnessIdx]), redeem, role: 'sellerToken' },
  ];
  const outputs: CovOutput[] = [
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, out1)), role: 'split' },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, out2)), role: 'change' },
  ];
  return { kind: 'sell', inputs, outputs, economics: { sellAmount, change }, covids: { tokenCovid: hexOf(owner) } };
}

/**
 * Consolidate several presence-owned token UTXOs (same owner) into ONE — a conserving kcc20 transfer (N covid-A
 * inputs → 1 output) authorized by a single co-present P2PK input at `presenceWitnessIdx`. Lets a holder merge
 * many small buys into one piece so a later sell needs just one (or two) inputs. No curve/pool involved.
 */
export function buildConsolidate(
  k: K, tokenTpl: Kcc20Template,
  tokens: { transactionId: string; index: number; value: bigint; state: Kcc20State }[],
  presenceWitnessIdx: number, opts: { tokenDust?: bigint } = {},
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
  const outputs: CovOutput[] = [
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, merged)), role: 'merged' },
  ];
  return { kind: 'sell', inputs, outputs, economics: { total }, covids: { tokenCovid: hexOf(owner) } };
}

const hexOf = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
