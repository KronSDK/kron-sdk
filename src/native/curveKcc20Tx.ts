// kcc20v1 (KCC-20 standard) family — curve builders (covenants/kcc20v1/curve_kcc20.sil). The family twin of
// ./curveCpTx.ts (frozen). Every shape follows the layouts recorded in docs/kcc20-spike/REPORT.md "Curve and order
// covenants" and the rules in docs/kcc20v1/PLAN.md §4: the curve is input 0; its inventory is the token leader at
// input 1; a holder's own pieces follow as delegators; the holder's P2PK funding input comes right after the
// covenant inputs and is named as the witness index; new holder pieces are p2pk-schnorr with borrowing disabled;
// a merged or change piece copies the holder's first piece; the sell's KAS leg is pinned at output 5.
// State span {1,44}: [01 graduated] [20 tokenCovid] [08 tokenReserve]. Entries are selected by KCC-1 dispatch tags.
// No top-level SDK import (only `import type`) — the caller passes the loaded WASM namespace `k`.
import type { Kaspa } from '../wasm/kaspa.types.js';
import { SigScriptBuilder } from './sigscript.js';
import { continuationValue, COVENANT_DUST } from './covenantSelect.js';
import { FEE_OUT_MIN, MAX_KAS, SCALE } from '../curve/cpCurve.js';
import { genesisCovenantId, covidToBytes } from './genesis.js';
import { assertFamilyTagsV1, hexOf } from './dispatchTag.js';
import type { CompiledV1 } from './templatesV1.js';
import {
  type Kcc20V1State, type Kcc20V1Template, ZERO32, OWNER_SCHEME, SIG65_PLACEHOLDER,
  int8SM, pushExplicit, concat, materializeKcc20V1Script, kcc20V1Spk, covenantOwnedV1, p2pkOwnedV1, changeLikeV1,
  assertHolderPieceV1, pushTokenStateV1, transferSigScriptV1, transferDelegatorSigScriptV1, leaderWitnessV1, authorityV1,
} from './kcc20V1Tx.js';
import type { CovenantSpendV1, CovInputV1, CovOutputV1 } from './covenantTxKcc20V1.js';
import { CURVE_V1_COMPUTE, TOKEN_V1_COMPUTE, ORDER_V1_COMPUTE } from './covenantTxKcc20V1.js';
import { type OrderV1Template, type OrderV1Utxo, materializeOrderV1Script, orderV1Spk, orderSettleSigV1, orderEscrowV1, orderFeesV1, ORDER_TOKEN_DUST, MIN_ORDER_KAS } from './orderKcc20Tx.js';
import { type PoolV1Template, type PoolV1State, encodePoolV1State } from './poolKcc20Tx.js';

type K = Kaspa;
type Spk = any;
export { SCALE };
export const MAX_TOKEN = 1_000_000_000n;
export const MAX_MERGE_PIECES = 2;
export const MAX_SELL_PIECES = 2;
export const MAX_BATCH = 2;
export const CURVE_V1_STATE_LEN = 44;
const padFee = (f: bigint) => (f > FEE_OUT_MIN ? f : FEE_OUT_MIN);
const p2pkSpk = (k: K, pubkey: Uint8Array): Spk => { const sb = new (k as any).ScriptBuilder(); sb.addData(pubkey).addOp(172); return new (k as any).ScriptPublicKey(0, sb.drain()); };
const outpoint = (u: { transactionId: string; index: number }) => ({ transactionId: u.transactionId, index: u.index });

/** Fixed per-token curve parameters (baked by silverc). */
export type CurveV1Params = {
  creatorFeeOwner: Uint8Array; platformFeeOwner: Uint8Array; devFundOwner: Uint8Array; creatorIdentifier: Uint8Array;
  vKas: bigint; graduationKas: bigint;
  creatorFeeBps: bigint; platformFeeBps: bigint; graduationFeeBps: bigint; devFundBps: bigint;
  poolLockedShares: bigint;
};
export type CurveV1Template = { prefix: Uint8Array; suffix: Uint8Array; templateHash: Uint8Array; tags: Record<string, Uint8Array>; params: CurveV1Params; token: Kcc20V1Template };
export type CurveV1State = { graduated: boolean; tokenCovid: Uint8Array; tokenReserve: bigint };
export type CurveV1Utxo = { transactionId: string; index: number; realKas: bigint; state: CurveV1State };
/** The curve's own inventory piece (owner = curve covid). `extensionCommitment` is the token's class (zero at genesis). */
export type InventoryUtxoV1 = { transactionId: string; index: number; value: bigint; amount: bigint; extensionCommitment?: Uint8Array };
/** A holder's token piece. */
export type TokenUtxoV1 = { transactionId: string; index: number; value: bigint; state: Kcc20V1State };

/** Build a curve template from a compiled artifact, refusing an ABI whose tags changed. */
export function curveTemplateFromCompiledV1(c: CompiledV1, params: CurveV1Params, token: Kcc20V1Template): CurveV1Template {
  const tags = assertFamilyTagsV1('curve', c.dispatchTags);
  if (c.stateSpan.offset !== 1 || c.stateSpan.len !== CURVE_V1_STATE_LEN) throw new Error(`curve state span {${c.stateSpan.offset},${c.stateSpan.len}} is not {1,44}`);
  if (!c.bytecodeHex.includes(hexOf(token.templateHash))) throw new Error('this curve was not compiled against the given token template');
  for (const key of ['creatorFeeOwner', 'platformFeeOwner', 'devFundOwner', 'creatorIdentifier'] as const) if (params[key].length !== 32) throw new Error(`${key} must be 32 bytes`);
  return { prefix: c.prefix, suffix: c.suffix, templateHash: hexToBytes(c.templateHash), tags, params, token };
}
const hexToBytes = (h: string): Uint8Array => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));

export const encodeCurveV1State = (s: CurveV1State): Uint8Array => {
  if (s.tokenCovid.length !== 32) throw new Error('tokenCovid must be 32 bytes');
  if (s.tokenReserve < 0n) throw new Error('tokenReserve must be non-negative');
  return concat([pushExplicit(Uint8Array.of(s.graduated ? 1 : 0)), pushExplicit(s.tokenCovid), pushExplicit(int8SM(s.tokenReserve))]);
};
export const materializeCurveV1Script = (tpl: CurveV1Template, s: CurveV1State): Uint8Array => concat([tpl.prefix, encodeCurveV1State(s), tpl.suffix]);
export const curveV1Spk = (k: K, redeem: Uint8Array): Spk => (k as any).payToScriptHashScript(redeem);
export const curveV1Address = (k: K, tpl: CurveV1Template, s: CurveV1State, network: string): string => (k as any).addressFromScriptPublicKey(curveV1Spk(k, materializeCurveV1Script(tpl, s)), network)?.toString() ?? '';

/** An entry's signature script: the pushed arguments, the dispatch tag, the redeem. */
function entrySig(k: K, tpl: CurveV1Template, entry: string, push: (b: SigScriptBuilder) => void, redeem: Uint8Array): string {
  const tag = tpl.tags[entry]; if (!tag) throw new Error(`curve has no entry ${entry}`);
  const b = new SigScriptBuilder(k); push(b); return b.data(tag).redeem(redeem).drain();
}
/** The curve's own input (always index 0). */
function curveInput(k: K, tpl: CurveV1Template, utxo: CurveV1Utxo, curveCovid: Uint8Array, entry: string, args: unknown[], push: (b: SigScriptBuilder) => void): CovInputV1 {
  const redeem = materializeCurveV1Script(tpl, utxo.state);
  return { ...outpoint(utxo), value: utxo.realKas, scriptPublicKey: curveV1Spk(k, redeem), redeem, covid: hexOf(curveCovid), role: 'curve', computeBudget: CURVE_V1_COMPUTE, signatureScript: entrySig(k, tpl, entry, push, redeem), invocation: { program: 'curve', entry, args } };
}
/** The inventory as the token LEADER (input 1): declares every successor; covenant-owned, so the witness is `00`. */
function inventoryLeader(k: K, tpl: CurveV1Template, inv: InventoryUtxoV1, curveCovid: Uint8Array, tokenCovid: Uint8Array, nextStates: Kcc20V1State[]): CovInputV1 {
  const state = covenantOwnedV1(curveCovid, inv.amount, inv.extensionCommitment ?? ZERO32);
  const redeem = materializeKcc20V1Script(tpl.token, state);
  const witness = leaderWitnessV1(new Uint8Array(0));
  return { ...outpoint(inv), value: inv.value, scriptPublicKey: kcc20V1Spk(k, redeem), redeem, covid: hexOf(tokenCovid), role: 'inventory', computeBudget: TOKEN_V1_COMPUTE, signatureScript: transferSigScriptV1(k, tpl.token, redeem, nextStates, witness), invocation: { program: 'token', entry: 'transfer', args: [nextStates, witness] } };
}
/** A holder's piece as a DELEGATOR: authority = its owner's signature (placeholder until the wallet signs). */
function holderDelegator(k: K, token: Kcc20V1Template, piece: TokenUtxoV1, holderPubkey: Uint8Array, tokenCovid: Uint8Array, role: string, blake3Of: (b: Uint8Array) => Uint8Array): CovInputV1 {
  assertHolderPieceV1(piece.state, holderPubkey, blake3Of);
  const redeem = materializeKcc20V1Script(token, piece.state);
  const withSignature = (sig65: Uint8Array) => transferDelegatorSigScriptV1(k, token, redeem, authorityV1(piece.state, sig65, holderPubkey));
  return { ...outpoint(piece), value: piece.value, scriptPublicKey: kcc20V1Spk(k, redeem), redeem, covid: hexOf(tokenCovid), role, computeBudget: TOKEN_V1_COMPUTE, signatureScript: withSignature(SIG65_PLACEHOLDER), invocation: { program: 'token', entry: 'transfer_delegator', args: [authorityV1(piece.state, SIG65_PLACEHOLDER, holderPubkey)] }, sign: { holderPubkey, ownerScheme: piece.state.ownerScheme, withSignature } };
}
const covOut = (value: bigint, spk: Spk, role: string, covid: Uint8Array | string, authorizingInput: number): CovOutputV1 => ({ value, scriptPublicKey: spk, role, covenant: { covid: typeof covid === 'string' ? covid : hexOf(covid), authorizingInput } });
const feeOut = (k: K, value: bigint, owner: Uint8Array, role: string): CovOutputV1 => ({ value, scriptPublicKey: p2pkSpk(k, owner), role });
/** BLAKE3 for p2pkh-schnorr owners; injected so this module stays SDK/hash-library free in the browser bundle path. */
export type Blake3 = (b: Uint8Array) => Uint8Array;

// --- genesis: the curve UTXO and its covenant id C --------------------------------------------------------------
export function buildCurveV1Genesis(k: K, tpl: CurveV1Template, fundingOutpoint: { transactionId: string; index: number }, seedKas: bigint, network: string, curveOutIndex = 0) {
  if (seedKas <= 0n || seedKas % SCALE !== 0n) throw new Error('the seed must be a positive multiple of SCALE (0.01 KAS)');
  const redeem = materializeCurveV1Script(tpl, { graduated: false, tokenCovid: ZERO32, tokenReserve: 0n });
  const spk = curveV1Spk(k, redeem);
  const curveCovid = genesisCovenantId(k, fundingOutpoint, [{ index: curveOutIndex, value: seedKas, scriptPublicKey: spk }]);
  return { curveCovid, curveAddress: (k as any).addressFromScriptPublicKey(spk, network)?.toString() ?? '', curveOutput: { value: seedKas, scriptPublicKey: spk }, redeem };
}

// --- init: bind the token (genesis over outputs 1 and 2) and pre-mint inventory + dev allocation -------------------
export function buildCurveV1Init(k: K, tpl: CurveV1Template, utxo: CurveV1Utxo, curveCovid: Uint8Array, inventoryAmount: bigint, devAmount: bigint, opts: { tokenDust?: bigint } = {}): CovenantSpendV1 {
  if (hexOf(tpl.params.creatorIdentifier) !== hexOf(tpl.params.creatorFeeOwner)) throw new Error('init is unsatisfiable unless creatorIdentifier == creatorFeeOwner (the covenant requires the witness input to be both)');
  if (inventoryAmount < 1n) throw new Error('inventory must be >= 1');
  if (devAmount < 1n) throw new Error('dev allocation must be >= 1 (use 1 for "no dev")');
  if (inventoryAmount > MAX_TOKEN - devAmount) throw new Error('inventory + dev allocation exceeds the 1,000,000,000 token cap');
  if (utxo.state.tokenCovid.some(Boolean)) throw new Error('this curve is already bound to a token');
  const dust = opts.tokenDust ?? COVENANT_DUST;
  const inventory = covenantOwnedV1(curveCovid, inventoryAmount);            // rule 2, D6: zero extension at genesis
  const devAlloc = p2pkOwnedV1(tpl.params.creatorIdentifier, devAmount);     // rule 3
  const invSpk = kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, inventory)), devSpk = kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, devAlloc));
  const tokenCovidHex = genesisCovenantId(k, outpoint(utxo), [{ index: 1, value: dust, scriptPublicKey: invSpk }, { index: 2, value: dust, scriptPublicKey: devSpk }]);
  const tokenCovid = covidToBytes(tokenCovidHex);
  const newRedeem = materializeCurveV1Script(tpl, { graduated: false, tokenCovid, tokenReserve: inventoryAmount });
  const args = [1n, inventory, devAlloc, tpl.token.prefix, tpl.token.suffix];
  const inputs: CovInputV1[] = [curveInput(k, tpl, utxo, curveCovid, 'init', args, (b) => { b.int(1n); pushTokenStateV1(b, tpl.token.templateHash, inventory); pushTokenStateV1(b, tpl.token.templateHash, devAlloc); b.data(tpl.token.prefix).data(tpl.token.suffix); })];
  const outputs: CovOutputV1[] = [
    covOut(utxo.realKas, curveV1Spk(k, newRedeem), 'curve', curveCovid, 0),
    covOut(dust, invSpk, 'inventory', tokenCovidHex, 0),
    covOut(dust, devSpk, 'devAlloc', tokenCovidHex, 0),
  ];
  return { family: 'kcc20v1', kind: 'init', inputs, outputs, economics: { inventoryAmount, devAmount }, covids: { tokenCovid: tokenCovidHex, curveCovid: hexOf(curveCovid) } };
}

// --- buy: kasIn into the reserve, tokenOut to the buyer, merging up to two of the buyer's own pieces ----------------
export function buildCurveV1Buy(k: K, tpl: CurveV1Template, utxo: CurveV1Utxo, inventory: InventoryUtxoV1, curveCovid: Uint8Array, buyerPubkey: Uint8Array, kasIn: bigint, tokenOut: bigint, mergeTokens: TokenUtxoV1[] = [], opts: { tokenDust?: bigint; blake3?: Blake3 } = {}): CovenantSpendV1 {
  if (utxo.state.graduated) throw new Error('curve has graduated, buys are locked');
  if (kasIn <= 0n || kasIn % SCALE !== 0n) throw new Error('kasIn must be a positive multiple of SCALE (0.01 KAS)');
  if (tokenOut <= 0n || tokenOut >= inventory.amount) throw new Error('invalid tokenOut');
  if (inventory.amount !== utxo.state.tokenReserve) throw new Error('inventory does not match the committed curve reserve');
  if (mergeTokens.length > MAX_MERGE_PIECES) throw new Error(`a buy merges at most ${MAX_MERGE_PIECES} existing pieces`);
  const dust = opts.tokenDust ?? COVENANT_DUST, blake3Of = opts.blake3 ?? noBlake3;
  const newKas = utxo.realKas + kasIn;
  if (newKas > MAX_KAS) throw new Error('buy exceeds the curve max raise (9,000,000 KAS)');
  const newToken = inventory.amount - tokenOut;
  if ((tpl.params.vKas + newKas / SCALE) * newToken < (tpl.params.vKas + utxo.realKas / SCALE) * inventory.amount) throw new Error('tokenOut exceeds the constant-product quote');
  const ext = inventory.extensionCommitment ?? ZERO32;
  const mergeSum = mergeTokens.reduce((s, t) => s + t.state.amount, 0n);
  const inventoryOut = covenantOwnedV1(curveCovid, newToken, ext);
  const buyerOut = mergeTokens.length ? changeLikeV1(mergeTokens[0].state, tokenOut + mergeSum, ext) : p2pkOwnedV1(buyerPubkey, tokenOut, ext);
  const buyerWitness = 2 + mergeTokens.length;
  const creatorFee = (kasIn * tpl.params.creatorFeeBps) / 10000n, platformFee = (kasIn * tpl.params.platformFeeBps) / 10000n, devFundFee = (kasIn * tpl.params.devFundBps) / 10000n;
  const nextStates = [inventoryOut, buyerOut];
  const A = utxo.state.tokenCovid;
  const inputs: CovInputV1[] = [
    curveInput(k, tpl, utxo, curveCovid, 'buy', [kasIn, tokenOut, inventoryOut, buyerOut, BigInt(buyerWitness), buyerPubkey], (b) => { b.int(kasIn).int(tokenOut); pushTokenStateV1(b, tpl.token.templateHash, inventoryOut); pushTokenStateV1(b, tpl.token.templateHash, buyerOut); b.int(BigInt(buyerWitness)).data(buyerPubkey); }),
    inventoryLeader(k, tpl, inventory, curveCovid, A, nextStates),
    ...mergeTokens.map((piece) => holderDelegator(k, tpl.token, piece, buyerPubkey, A, 'buyerToken', blake3Of)),
  ];
  const outputs: CovOutputV1[] = [
    covOut(newKas, curveV1Spk(k, materializeCurveV1Script(tpl, { graduated: false, tokenCovid: A, tokenReserve: newToken })), 'curve', curveCovid, 0),
    covOut(continuationValue(dust, inventory.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, inventoryOut)), 'inventory', A, 1),
    covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, buyerOut)), 'recipient', A, 1),
    feeOut(k, padFee(creatorFee), tpl.params.creatorFeeOwner, 'creatorFee'),
    feeOut(k, padFee(platformFee), tpl.params.platformFeeOwner, 'platformFee'),
    feeOut(k, padFee(devFundFee), tpl.params.devFundOwner, 'devFundFee'),
  ];
  return { family: 'kcc20v1', kind: 'buy', inputs, outputs, economics: { kasIn, tokenOut, creatorFee, platformFee, devFundFee, newRealKas: newKas, newTokenReserve: newToken, merged: mergeSum }, covids: { tokenCovid: hexOf(A), curveCovid: hexOf(curveCovid) } };
}
const noBlake3: Blake3 = () => { throw new Error('a p2pkh-schnorr piece needs a BLAKE3 implementation (pass opts.blake3)'); };

// --- sell: fold tokenIn from the holder's pieces (≤ 2), pay kasOut net of fees at output 5, change last -----------
export function buildCurveV1Sell(k: K, tpl: CurveV1Template, utxo: CurveV1Utxo, sellerTokens: TokenUtxoV1[], inventory: InventoryUtxoV1, curveCovid: Uint8Array, sellerPubkey: Uint8Array, tokenIn: bigint, kasOut: bigint, opts: { tokenDust?: bigint; blake3?: Blake3 } = {}): CovenantSpendV1 {
  if (utxo.state.graduated) throw new Error('curve has graduated, sells are locked');
  if (sellerTokens.length < 1 || sellerTokens.length > MAX_SELL_PIECES) throw new Error(`a sell takes 1..${MAX_SELL_PIECES} of the seller's pieces`);
  if (tokenIn <= 0n) throw new Error('tokenIn must be positive');
  if (kasOut <= 0n || kasOut % SCALE !== 0n || kasOut >= utxo.realKas) throw new Error('invalid kasOut — must leave at least 0.01 KAS in the curve');
  if (inventory.amount !== utxo.state.tokenReserve) throw new Error('inventory does not match the committed curve reserve');
  const dust = opts.tokenDust ?? COVENANT_DUST, blake3Of = opts.blake3 ?? noBlake3;
  const sellerIn = sellerTokens.reduce((s, t) => s + t.state.amount, 0n);
  const change = sellerIn - tokenIn;
  if (change < 0n) throw new Error('seller pieces hold less than the sell amount');
  const newToken = inventory.amount + tokenIn, newKas = utxo.realKas - kasOut;
  if (newToken > MAX_TOKEN) throw new Error('sell exceeds the token cap');
  if ((tpl.params.vKas + newKas / SCALE) * newToken < (tpl.params.vKas + utxo.realKas / SCALE) * inventory.amount) throw new Error('kasOut exceeds the constant-product quote');
  const ext = inventory.extensionCommitment ?? ZERO32;
  const inventoryOut = covenantOwnedV1(curveCovid, newToken, ext);
  const first = sellerTokens[0].state;
  const traderChangeOut = changeLikeV1(first, change > 0n ? change : 1n, ext); // dummy(1) on a full sell — the covenant ignores it
  const sellerWitness = 2 + sellerTokens.length;
  const creatorFee = (kasOut * tpl.params.creatorFeeBps) / 10000n, platformFee = (kasOut * tpl.params.platformFeeBps) / 10000n, devFundFee = (kasOut * tpl.params.devFundBps) / 10000n;
  const kasLeg = kasOut - creatorFee - platformFee - devFundFee;
  const nextStates = change > 0n ? [inventoryOut, traderChangeOut] : [inventoryOut];
  const A = utxo.state.tokenCovid;
  const inputs: CovInputV1[] = [
    curveInput(k, tpl, utxo, curveCovid, 'sell', [tokenIn, kasOut, inventoryOut, traderChangeOut, BigInt(sellerWitness), sellerPubkey], (b) => { b.int(tokenIn).int(kasOut); pushTokenStateV1(b, tpl.token.templateHash, inventoryOut); pushTokenStateV1(b, tpl.token.templateHash, traderChangeOut); b.int(BigInt(sellerWitness)).data(sellerPubkey); }),
    inventoryLeader(k, tpl, inventory, curveCovid, A, nextStates),
    ...sellerTokens.map((piece) => holderDelegator(k, tpl.token, piece, sellerPubkey, A, 'sellerToken', blake3Of)),
  ];
  const outputs: CovOutputV1[] = [
    covOut(newKas, curveV1Spk(k, materializeCurveV1Script(tpl, { graduated: false, tokenCovid: A, tokenReserve: newToken })), 'curve', curveCovid, 0),
    covOut(continuationValue(dust, inventory.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, inventoryOut)), 'inventory', A, 1),
    feeOut(k, padFee(creatorFee), tpl.params.creatorFeeOwner, 'creatorFee'),
    feeOut(k, padFee(platformFee), tpl.params.platformFeeOwner, 'platformFee'),
    feeOut(k, padFee(devFundFee), tpl.params.devFundOwner, 'devFundFee'),
    feeOut(k, kasLeg, sellerPubkey, 'sellerKas'),                                   // SELL_KAS_OUT = 5 (rule 5)
  ];
  if (change > 0n) outputs.push(covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, traderChangeOut)), 'sellerChange', A, 1));
  return { family: 'kcc20v1', kind: 'sell', inputs, outputs, economics: { tokenIn, kasOut, change, creatorFee, platformFee, devFundFee, kasLeg, newRealKas: newKas, newTokenReserve: newToken }, covids: { tokenCovid: hexOf(A), curveCovid: hexOf(curveCovid) } };
}

// --- graduate: lock the curve, seed the pool (genesis at output 1) with the leftover inventory -------------------------
export function buildCurveV1Graduate(k: K, tpl: CurveV1Template, utxo: CurveV1Utxo, inventory: InventoryUtxoV1, curveCovid: Uint8Array, poolTpl: PoolV1Template, opts: { lockedCurveValue?: bigint; tokenDust?: bigint } = {}): CovenantSpendV1 {
  if (utxo.state.graduated) throw new Error('already graduated');
  if (utxo.realKas < tpl.params.graduationKas) throw new Error('reserve has not reached the graduation target');
  if (inventory.amount !== utxo.state.tokenReserve) throw new Error('inventory does not match the committed curve reserve');
  if (!tpl.suffix.length || !hexOf(concat([tpl.prefix, tpl.suffix])).includes(hexOf(poolTpl.templateHash))) throw new Error('this curve was not compiled against the given pool template');
  const lockedValue = opts.lockedCurveValue ?? COVENANT_DUST, dust = opts.tokenDust ?? COVENANT_DUST;
  const poolKasUnits = ((utxo.realKas * (10000n - tpl.params.graduationFeeBps)) / 10000n) / SCALE;
  const poolKas = poolKasUnits * SCALE, gradFee = utxo.realKas - poolKas;
  const A = utxo.state.tokenCovid, ext = inventory.extensionCommitment ?? ZERO32;
  const poolState: PoolV1State = { kasReserve: poolKasUnits, tokenReserve: inventory.amount, tokenCovid: A, totalShares: tpl.params.poolLockedShares, lpCovid: ZERO32 };
  const poolRedeem = concat([poolTpl.prefix, encodePoolV1State(poolState), poolTpl.suffix]);
  const poolSpk = (k as any).payToScriptHashScript(poolRedeem);
  const poolCovidHex = genesisCovenantId(k, outpoint(utxo), [{ index: 1, value: poolKas, scriptPublicKey: poolSpk }]);
  const poolTokens = covenantOwnedV1(covidToBytes(poolCovidHex), inventory.amount, ext);   // rule 2 under the pool's id
  const lockedRedeem = materializeCurveV1Script(tpl, { graduated: true, tokenCovid: A, tokenReserve: inventory.amount });
  const inputs: CovInputV1[] = [
    curveInput(k, tpl, utxo, curveCovid, 'graduate', [poolState, poolTokens, poolTpl.prefix, poolTpl.suffix], (b) => { b.int(poolState.kasReserve).int(poolState.tokenReserve).data(poolState.tokenCovid).int(poolState.totalShares).data(poolState.lpCovid); pushTokenStateV1(b, tpl.token.templateHash, poolTokens); b.data(poolTpl.prefix).data(poolTpl.suffix); }),
    inventoryLeader(k, tpl, inventory, curveCovid, A, [poolTokens]),
  ];
  const outputs: CovOutputV1[] = [
    covOut(lockedValue, curveV1Spk(k, lockedRedeem), 'curve', curveCovid, 0),
    covOut(poolKas, poolSpk, 'pool', poolCovidHex, 0),
    covOut(continuationValue(dust, inventory.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, poolTokens)), 'poolToken', A, 1),
    feeOut(k, padFee(gradFee), tpl.params.platformFeeOwner, 'gradFee'),
  ];
  return { family: 'kcc20v1', kind: 'graduate', inputs, outputs, economics: { poolKas, gradFee, leftover: inventory.amount, poolLockedShares: tpl.params.poolLockedShares }, covids: { tokenCovid: hexOf(A), curveCovid: hexOf(curveCovid), poolCovid: poolCovidHex } };
}

// --- batchBuy: settle exactly two orders at one aggregate price (keyless; the orders pre-fund everything) -----------
export function buildCurveV1BatchBuy(k: K, tpl: CurveV1Template, orderTpl: OrderV1Template, utxo: CurveV1Utxo, inventory: InventoryUtxoV1, curveCovid: Uint8Array, orders: OrderV1Utxo[], opts: { tokenDust?: bigint } = {}): CovenantSpendV1 {
  if (utxo.state.graduated) throw new Error('curve has graduated, buys are locked');
  if (inventory.amount !== utxo.state.tokenReserve) throw new Error('inventory does not match the committed curve reserve');
  if (orders.length < 2 || orders.length > MAX_BATCH) throw new Error(`batchBuy settles 2..${MAX_BATCH} orders`);
  const dust = opts.tokenDust ?? ORDER_TOKEN_DUST;
  if (dust !== ORDER_TOKEN_DUST) throw new Error('the covenant pins each buyer output at exactly ORDER_TOKEN_DUST');
  const A = utxo.state.tokenCovid, ext = inventory.extensionCommitment ?? ZERO32;
  let totalKas = 0n, totalUnits = 0n, creatorFees = 0n, platformFees = 0n, devFundFees = 0n;
  for (const o of orders) {
    if (hexOf(o.state.curveCovid) !== hexOf(curveCovid)) throw new Error('order is bound to a different curve');
    if (hexOf(o.state.tokenCovid) !== hexOf(A)) throw new Error('order names a different token (rule 6)');
    if (o.state.kasIn < MIN_ORDER_KAS || o.state.kasIn % SCALE !== 0n) throw new Error('order kasIn must be at least 0.5 KAS and a SCALE multiple');
    const f = orderFeesV1(o.state.kasIn, tpl.params);
    if (o.value !== orderEscrowV1(o.state.kasIn, tpl.params)) throw new Error('order escrow value is not exact');
    totalKas += o.state.kasIn; totalUnits += o.state.kasIn / SCALE; creatorFees += f.creator; platformFees += f.platform; devFundFees += f.devFund;
  }
  const newKas = utxo.realKas + totalKas;
  if (newKas > MAX_KAS) throw new Error('batch exceeds the curve reserve bound');
  // the covenant's price band: kFloor ≤ q·newToken ≤ kFloor + q  ⇒  newToken = ceil(kFloor / q)
  const q = tpl.params.vKas + newKas / SCALE, kFloor = (tpl.params.vKas + utxo.realKas / SCALE) * inventory.amount;
  const newToken = (kFloor + q - 1n) / q;
  if (newToken < 1n || newToken >= inventory.amount) throw new Error('batch leaves no inventory or buys nothing');
  const totalTokenOut = inventory.amount - newToken;
  let allocated = 0n;
  const buyers = orders.map((o, i) => {
    let share = (totalTokenOut * (o.state.kasIn / SCALE)) / totalUnits;
    if (i === orders.length - 1) share = totalTokenOut - allocated;
    allocated += share;
    if (share < o.state.minTokenOut) throw new Error(`order ${i} would receive ${share} < its minimum ${o.state.minTokenOut}`);
    return p2pkOwnedV1(o.state.buyerIdentifier, share, ext);                // rule 3: default holder pieces
  });
  const inventoryOut = covenantOwnedV1(curveCovid, newToken, ext);
  const nextStates = [inventoryOut, ...buyers];
  const inputs: CovInputV1[] = [
    curveInput(k, tpl, utxo, curveCovid, 'batchBuy', [BigInt(orders.length), inventoryOut], (b) => { b.int(BigInt(orders.length)); pushTokenStateV1(b, tpl.token.templateHash, inventoryOut); }),
    inventoryLeader(k, tpl, inventory, curveCovid, A, nextStates),
    ...orders.map((o, slot) => {
      const redeem = materializeOrderV1Script(orderTpl, o.state);
      return { ...outpoint(o), value: o.value, scriptPublicKey: orderV1Spk(k, redeem), redeem, covid: o.covid, role: 'order', computeBudget: ORDER_V1_COMPUTE, signatureScript: orderSettleSigV1(k, orderTpl, redeem, buyers[slot]), invocation: { program: 'order' as const, entry: 'settle', args: [buyers[slot]] } };
    }),
  ];
  const outputs: CovOutputV1[] = [
    covOut(newKas, curveV1Spk(k, materializeCurveV1Script(tpl, { graduated: false, tokenCovid: A, tokenReserve: newToken })), 'curve', curveCovid, 0),
    covOut(continuationValue(dust, inventory.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, inventoryOut)), 'inventory', A, 1),
    ...buyers.map((buyer) => covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, buyer)), 'recipient', A, 1)),
    feeOut(k, creatorFees, tpl.params.creatorFeeOwner, 'creatorFee'),      // exact sums (the covenant uses ==)
    feeOut(k, platformFees, tpl.params.platformFeeOwner, 'platformFee'),
    feeOut(k, devFundFees, tpl.params.devFundOwner, 'devFundFee'),
  ];
  return { family: 'kcc20v1', kind: 'batchBuy', inputs, outputs, fixedOutputs: true, economics: { count: BigInt(orders.length), totalKas, totalTokenOut, creatorFees, platformFees, devFundFees, newRealKas: newKas, newTokenReserve: newToken }, covids: { tokenCovid: hexOf(A), curveCovid: hexOf(curveCovid) } };
}
export { OWNER_SCHEME };
