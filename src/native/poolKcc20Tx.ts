// kcc20v1 (KCC-20 standard) family — pool builders (covenants/kcc20v1/pool_kcc20.sil). Twin of ./poolCpV3Tx.ts
// (frozen). Economics (quotes) are the audited pool's and are REUSED from ./poolCpTx.ts unchanged; what differs is
// the token model and the layouts PLAN.md §4 pins (docs/kcc20-spike/REPORT.md "Pool covenant"): the pool is input 0;
// its reserve piece is the token leader at input 1; the LP inventory is the leader among LP-token inputs; a holder's
// pieces are delegators; the holder's P2PK funding input follows the covenant inputs and is the witness index. A pool
// buy mints a NEW default holder piece (no merge — the covenant pins one token input); a sell takes ≤ 2 pieces and
// pays the KAS leg at output 4 with the change last; addLiquidity is laid out reserve(1) / deposit(2) / LP inventory(3).
// State span {1,93}: [08 kasReserve] [08 tokenReserve] [20 tokenCovid] [08 totalShares] [20 lpCovid].
import type { Kaspa } from '../wasm/kaspa.types.js';
import { SigScriptBuilder } from './sigscript.js';
import { continuationValue, COVENANT_DUST } from './covenantSelect.js';
import { SCALE } from '../curve/cpCurve.js';
import { genesisCovenantId, covidToBytes } from './genesis.js';
import { assertFamilyTagsV1, hexOf } from './dispatchTag.js';
import type { CompiledV1 } from './templatesV1.js';
import { MAX_SHARES, quotePoolCpBuy, quotePoolCpSell, quoteAddLiquidity, quoteRemoveLiquidity, type PoolCpBuyQuote, type PoolCpSellQuote, type AddLiquidityQuote, type RemoveLiquidityQuote } from './poolCpTx.js';
import {
  type Kcc20V1State, type Kcc20V1Template, ZERO32, SIG65_PLACEHOLDER,
  int8SM, pushExplicit, concat, materializeKcc20V1Script, kcc20V1Spk, covenantOwnedV1, p2pkOwnedV1, changeLikeV1,
  assertHolderPieceV1, pushTokenStateV1, transferSigScriptV1, transferDelegatorSigScriptV1, leaderWitnessV1, authorityV1,
} from './kcc20V1Tx.js';
import type { CovenantSpendV1, CovInputV1, CovOutputV1 } from './covenantTxKcc20V1.js';
import { POOL_V1_COMPUTE, TOKEN_V1_COMPUTE } from './covenantTxKcc20V1.js';

type K = Kaspa;
type Spk = any;
export { MAX_SHARES, quotePoolCpBuy as quotePoolV1Buy, quotePoolCpSell as quotePoolV1Sell, quoteAddLiquidity as quoteAddLiquidityV1, quoteRemoveLiquidity as quoteRemoveLiquidityV1 };
export const POOL_V1_STATE_LEN = 93;
export const MAX_TRADER_PIECES = 2;
const p2pkSpk = (k: K, pubkey: Uint8Array): Spk => { const sb = new (k as any).ScriptBuilder(); sb.addData(pubkey).addOp(172); return new (k as any).ScriptPublicKey(0, sb.drain()); };
const outpoint = (u: { transactionId: string; index: number }) => ({ transactionId: u.transactionId, index: u.index });
const hexToBytes = (h: string): Uint8Array => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
export type Blake3 = (b: Uint8Array) => Uint8Array;
const noBlake3: Blake3 = () => { throw new Error('a p2pkh-schnorr piece needs a BLAKE3 implementation (pass opts.blake3)'); };

/** Fixed per-pool parameters (baked by silverc) — the audited PoolCpParams shape, so the quotes apply unchanged. */
export type PoolV1Params = { creatorFeeOwner: Uint8Array; platformFeeOwner: Uint8Array; creatorFeeBps: bigint; platformFeeBps: bigint; lpFeeBps: bigint; lockedShares: bigint };
export type PoolV1Template = { prefix: Uint8Array; suffix: Uint8Array; templateHash: Uint8Array; tags: Record<string, Uint8Array>; params: PoolV1Params; token: Kcc20V1Template };
export type PoolV1State = { kasReserve: bigint; tokenReserve: bigint; tokenCovid: Uint8Array; totalShares: bigint; lpCovid: Uint8Array };
/** The live pool UTXO (value = kasReserve·SCALE) and its pool-owned token reserve piece. */
export type PoolV1Utxo = { transactionId: string; index: number; state: PoolV1State; tokenUtxo: { transactionId: string; index: number; value: bigint; extensionCommitment?: Uint8Array } };
/** The pool-owned LP-token inventory piece (amount = MAX_SHARES − totalShares). */
export type LpInventoryUtxoV1 = { transactionId: string; index: number; value: bigint; amount: bigint; extensionCommitment?: Uint8Array };
export type TokenUtxoV1 = { transactionId: string; index: number; value: bigint; state: Kcc20V1State };

export function poolTemplateFromCompiledV1(c: CompiledV1, params: PoolV1Params, token: Kcc20V1Template): PoolV1Template {
  const tags = assertFamilyTagsV1('pool', c.dispatchTags);
  if (c.stateSpan.offset !== 1 || c.stateSpan.len !== POOL_V1_STATE_LEN) throw new Error(`pool state span {${c.stateSpan.offset},${c.stateSpan.len}} is not {1,93}`);
  if (!c.bytecodeHex.includes(hexOf(token.templateHash))) throw new Error('this pool was not compiled against the given token template');
  return { prefix: c.prefix, suffix: c.suffix, templateHash: hexToBytes(c.templateHash), tags, params, token };
}
export const encodePoolV1State = (s: PoolV1State): Uint8Array => {
  if (s.tokenCovid.length !== 32 || s.lpCovid.length !== 32) throw new Error('pool covenant ids must be 32 bytes');
  if (s.kasReserve < 0n || s.tokenReserve < 0n || s.totalShares < 0n) throw new Error('pool reserves must be non-negative');
  return concat([pushExplicit(int8SM(s.kasReserve)), pushExplicit(int8SM(s.tokenReserve)), pushExplicit(s.tokenCovid), pushExplicit(int8SM(s.totalShares)), pushExplicit(s.lpCovid)]);
};
export const materializePoolV1Script = (tpl: PoolV1Template, s: PoolV1State): Uint8Array => concat([tpl.prefix, encodePoolV1State(s), tpl.suffix]);
export const poolV1Spk = (k: K, redeem: Uint8Array): Spk => (k as any).payToScriptHashScript(redeem);
export const poolV1Address = (k: K, tpl: PoolV1Template, s: PoolV1State, network: string): string => (k as any).addressFromScriptPublicKey(poolV1Spk(k, materializePoolV1Script(tpl, s)), network)?.toString() ?? '';

function entrySig(k: K, tpl: PoolV1Template, entry: string, push: (b: SigScriptBuilder) => void, redeem: Uint8Array): string {
  const tag = tpl.tags[entry]; if (!tag) throw new Error(`pool has no entry ${entry}`);
  const b = new SigScriptBuilder(k); push(b); return b.data(tag).redeem(redeem).drain();
}
function poolInput(k: K, tpl: PoolV1Template, utxo: PoolV1Utxo, poolCovid: Uint8Array, entry: string, args: unknown[], push: (b: SigScriptBuilder) => void): CovInputV1 {
  const redeem = materializePoolV1Script(tpl, utxo.state);
  return { ...outpoint(utxo), value: utxo.state.kasReserve * SCALE, scriptPublicKey: poolV1Spk(k, redeem), redeem, covid: hexOf(poolCovid), role: 'pool', computeBudget: POOL_V1_COMPUTE, signatureScript: entrySig(k, tpl, entry, push, redeem), invocation: { program: 'pool', entry, args } };
}
/** A pool-owned piece as a token LEADER (the reserve at input 1, or the LP inventory): witness `00`. */
function poolOwnedLeader(k: K, token: Kcc20V1Template, u: { transactionId: string; index: number; value: bigint; extensionCommitment?: Uint8Array }, amount: bigint, poolCovid: Uint8Array, covid: Uint8Array, role: string, nextStates: Kcc20V1State[]): CovInputV1 {
  const state = covenantOwnedV1(poolCovid, amount, u.extensionCommitment ?? ZERO32);
  const redeem = materializeKcc20V1Script(token, state);
  const witness = leaderWitnessV1(new Uint8Array(0));
  return { ...outpoint(u), value: u.value, scriptPublicKey: kcc20V1Spk(k, redeem), redeem, covid: hexOf(covid), role, computeBudget: TOKEN_V1_COMPUTE, signatureScript: transferSigScriptV1(k, token, redeem, nextStates, witness), invocation: { program: 'token', entry: 'transfer', args: [nextStates, witness] } };
}
function holderDelegator(k: K, token: Kcc20V1Template, piece: TokenUtxoV1, holderPubkey: Uint8Array, covid: Uint8Array, role: string, blake3Of: Blake3): CovInputV1 {
  assertHolderPieceV1(piece.state, holderPubkey, blake3Of);
  const redeem = materializeKcc20V1Script(token, piece.state);
  const withSignature = (sig65: Uint8Array) => transferDelegatorSigScriptV1(k, token, redeem, authorityV1(piece.state, sig65, holderPubkey));
  return { ...outpoint(piece), value: piece.value, scriptPublicKey: kcc20V1Spk(k, redeem), redeem, covid: hexOf(covid), role, computeBudget: TOKEN_V1_COMPUTE, signatureScript: withSignature(SIG65_PLACEHOLDER), invocation: { program: 'token', entry: 'transfer_delegator', args: [authorityV1(piece.state, SIG65_PLACEHOLDER, holderPubkey)] }, sign: { holderPubkey, ownerScheme: piece.state.ownerScheme, withSignature } };
}
const covOut = (value: bigint, spk: Spk, role: string, covid: Uint8Array | string, authorizingInput: number): CovOutputV1 => ({ value, scriptPublicKey: spk, role, covenant: { covid: typeof covid === 'string' ? covid : hexOf(covid), authorizingInput } });
const feeOut = (k: K, value: bigint, owner: Uint8Array, role: string): CovOutputV1 => ({ value, scriptPublicKey: p2pkSpk(k, owner), role });
const req = <T>(q: T | null, what: string): T => { if (q == null) throw new Error(`${what}: no quote for these amounts`); return q; };

/** swapKasForToken: the trader's KAS buys `q.tokenOut`, minted as ONE new default holder piece (no merge here).
 *  Outputs [pool, pool token, trader token, creator fee (incl. floor rent), platform fee]. */
export function buildPoolV1SwapKasForToken(k: K, tpl: PoolV1Template, utxo: PoolV1Utxo, poolCovid: Uint8Array, traderPubkey: Uint8Array, kasInSompi: bigint, opts: { tokenDust?: bigint } = {}): CovenantSpendV1 & { quote: PoolCpBuyQuote } {
  const dust = opts.tokenDust ?? COVENANT_DUST;
  const q = req(quotePoolCpBuy(utxo.state, tpl.params, kasInSompi), 'swapKasForToken');
  const { tokenCovid: A, totalShares, lpCovid } = utxo.state; const ext = utxo.tokenUtxo.extensionCommitment ?? ZERO32;
  const poolTokenOut = covenantOwnedV1(poolCovid, q.newToken, ext), traderOut = p2pkOwnedV1(traderPubkey, q.tokenOut, ext);
  const traderWitness = 2;
  const nextStates = [poolTokenOut, traderOut];
  const inputs: CovInputV1[] = [
    poolInput(k, tpl, utxo, poolCovid, 'swapKasForToken', [q.kasInUnits, q.tokenOut, poolTokenOut, traderOut, BigInt(traderWitness), traderPubkey], (b) => { b.int(q.kasInUnits).int(q.tokenOut); pushTokenStateV1(b, tpl.token.templateHash, poolTokenOut); pushTokenStateV1(b, tpl.token.templateHash, traderOut); b.int(BigInt(traderWitness)).data(traderPubkey); }),
    poolOwnedLeader(k, tpl.token, utxo.tokenUtxo, utxo.state.tokenReserve, poolCovid, A, 'poolToken', nextStates),
  ];
  const outputs: CovOutputV1[] = [
    covOut(q.newKas * SCALE, poolV1Spk(k, materializePoolV1Script(tpl, { ...utxo.state, kasReserve: q.newKas, tokenReserve: q.newToken, totalShares, lpCovid })), 'pool', poolCovid, 0),
    covOut(continuationValue(dust, utxo.tokenUtxo.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, poolTokenOut)), 'poolToken', A, 1),
    covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, traderOut)), 'trader', A, 1),
    feeOut(k, q.creatorOut, tpl.params.creatorFeeOwner, 'creatorFee'),
    feeOut(k, q.platformOut, tpl.params.platformFeeOwner, 'platformFee'),
  ];
  return { family: 'kcc20v1', kind: 'swapKasForToken', inputs, outputs, economics: { kasIn: q.kasIn, tokenOut: q.tokenOut, creatorOut: q.creatorOut, platformOut: q.platformOut }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(A) }, quote: q };
}

/** swapTokenForKas: fold `tokenIn` from the trader's pieces (≤ 2) into the reserve; the KAS leg (net of the two bps
 *  fees) is pinned at output 4 and the change — copying the trader's first piece — comes last. */
export function buildPoolV1SwapTokenForKas(k: K, tpl: PoolV1Template, utxo: PoolV1Utxo, poolCovid: Uint8Array, traderPubkey: Uint8Array, traderTokens: TokenUtxoV1[], tokenIn: bigint, opts: { tokenDust?: bigint; blake3?: Blake3 } = {}): CovenantSpendV1 & { quote: PoolCpSellQuote } {
  if (traderTokens.length < 1 || traderTokens.length > MAX_TRADER_PIECES) throw new Error(`a swap sells 1..${MAX_TRADER_PIECES} pieces`);
  const dust = opts.tokenDust ?? COVENANT_DUST, blake3Of = opts.blake3 ?? noBlake3;
  const q = req(quotePoolCpSell(utxo.state, tpl.params, tokenIn), 'swapTokenForKas');
  const traderIn = traderTokens.reduce((s, t) => s + t.state.amount, 0n);
  const change = traderIn - tokenIn;
  if (change < 0n) throw new Error('trader pieces hold less than the sell amount');
  const { tokenCovid: A } = utxo.state; const ext = utxo.tokenUtxo.extensionCommitment ?? ZERO32;
  const poolTokenOut = covenantOwnedV1(poolCovid, q.newToken, ext);
  const traderChangeOut = changeLikeV1(traderTokens[0].state, change > 0n ? change : 1n, ext);
  const traderWitness = 2 + traderTokens.length;
  const nextStates = change > 0n ? [poolTokenOut, traderChangeOut] : [poolTokenOut];
  const kasLeg = q.kasOut - q.creatorFee - q.platformFee;
  const inputs: CovInputV1[] = [
    poolInput(k, tpl, utxo, poolCovid, 'swapTokenForKas', [q.kasOutUnits, poolTokenOut, traderChangeOut, BigInt(traderWitness), traderPubkey], (b) => { b.int(q.kasOutUnits); pushTokenStateV1(b, tpl.token.templateHash, poolTokenOut); pushTokenStateV1(b, tpl.token.templateHash, traderChangeOut); b.int(BigInt(traderWitness)).data(traderPubkey); }),
    poolOwnedLeader(k, tpl.token, utxo.tokenUtxo, utxo.state.tokenReserve, poolCovid, A, 'poolToken', nextStates),
    ...traderTokens.map((piece) => holderDelegator(k, tpl.token, piece, traderPubkey, A, 'traderToken', blake3Of)),
  ];
  const outputs: CovOutputV1[] = [
    covOut(q.newKas * SCALE, poolV1Spk(k, materializePoolV1Script(tpl, { ...utxo.state, kasReserve: q.newKas, tokenReserve: q.newToken })), 'pool', poolCovid, 0),
    covOut(continuationValue(dust, utxo.tokenUtxo.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, poolTokenOut)), 'poolToken', A, 1),
    feeOut(k, q.creatorOut, tpl.params.creatorFeeOwner, 'creatorFee'),
    feeOut(k, q.platformOut, tpl.params.platformFeeOwner, 'platformFee'),
    feeOut(k, kasLeg, traderPubkey, 'traderKas'),                                                     // SWAP_KAS_OUT = 4
  ];
  if (change > 0n) outputs.push(covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, traderChangeOut)), 'traderChange', A, 1));
  return { family: 'kcc20v1', kind: 'swapTokenForKas', inputs, outputs, economics: { tokenIn, kasOut: q.kasOut, change, kasLeg, creatorOut: q.creatorOut, platformOut: q.platformOut }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(A) }, quote: q };
}

/** addLiquidity (D4 layout): inputs [pool, reserve, deposit (exactly dToken), LP inventory, LP P2PK]; outputs
 *  [pool, pool token, pool LP, LP shares]. */
export function buildPoolV1AddLiquidity(k: K, tpl: PoolV1Template, utxo: PoolV1Utxo, lpInventory: LpInventoryUtxoV1, poolCovid: Uint8Array, lpCovid: Uint8Array, deposit: TokenUtxoV1, lpPubkey: Uint8Array, dKas: bigint, opts: { tokenDust?: bigint; blake3?: Blake3 } = {}): CovenantSpendV1 & { quote: AddLiquidityQuote } {
  const dust = opts.tokenDust ?? COVENANT_DUST, blake3Of = opts.blake3 ?? noBlake3;
  if (!utxo.state.lpCovid.some(Boolean)) throw new Error('the pool has not bound its LP token yet (bindLp first)');
  if (hexOf(utxo.state.lpCovid) !== hexOf(lpCovid)) throw new Error('lpCovid does not match the pool state');
  const q = quoteAddLiquidity(utxo.state, dKas);
  if (deposit.state.amount !== q.dToken) throw new Error(`the deposit piece must hold exactly ${q.dToken} tokens (split first)`);
  if (lpInventory.amount !== MAX_SHARES - utxo.state.totalShares) throw new Error('LP inventory does not match the pool state');
  const { tokenCovid: A } = utxo.state; const ext = utxo.tokenUtxo.extensionCommitment ?? ZERO32, lpExt = lpInventory.extensionCommitment ?? ZERO32;
  const poolTokenOut = covenantOwnedV1(poolCovid, q.newToken, ext);
  const poolLpOut = covenantOwnedV1(poolCovid, MAX_SHARES - q.newShares, lpExt);
  const lpSharesOut = p2pkOwnedV1(lpPubkey, q.dShares, lpExt);
  const lpWitness = 4;
  const inputs: CovInputV1[] = [
    poolInput(k, tpl, utxo, poolCovid, 'addLiquidity', [q.dKas, q.dToken, q.dShares, poolTokenOut, poolLpOut, lpSharesOut, BigInt(lpWitness), lpPubkey], (b) => { b.int(q.dKas).int(q.dToken).int(q.dShares); pushTokenStateV1(b, tpl.token.templateHash, poolTokenOut); pushTokenStateV1(b, tpl.token.templateHash, poolLpOut); pushTokenStateV1(b, tpl.token.templateHash, lpSharesOut); b.int(BigInt(lpWitness)).data(lpPubkey); }),
    poolOwnedLeader(k, tpl.token, utxo.tokenUtxo, utxo.state.tokenReserve, poolCovid, A, 'poolToken', [poolTokenOut]),
    holderDelegator(k, tpl.token, deposit, lpPubkey, A, 'deposit', blake3Of),
    poolOwnedLeader(k, tpl.token, lpInventory, lpInventory.amount, poolCovid, lpCovid, 'lpInventory', [poolLpOut, lpSharesOut]),
  ];
  const outputs: CovOutputV1[] = [
    covOut(q.newKas * SCALE, poolV1Spk(k, materializePoolV1Script(tpl, { ...utxo.state, kasReserve: q.newKas, tokenReserve: q.newToken, totalShares: q.newShares })), 'pool', poolCovid, 0),
    covOut(continuationValue(dust, utxo.tokenUtxo.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, poolTokenOut)), 'poolToken', A, 1),
    covOut(continuationValue(dust, lpInventory.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, poolLpOut)), 'poolLp', lpCovid, 3),
    covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, lpSharesOut)), 'lpShares', lpCovid, 3),
  ];
  return { family: 'kcc20v1', kind: 'addLiquidity', inputs, outputs, economics: { dKas: q.dKas, dToken: q.dToken, dShares: q.dShares }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(A), lpCovid: hexOf(lpCovid) }, quote: q };
}

/** removeLiquidity: inputs [pool, reserve, LP inventory, holder LP piece (exactly dShares), LP P2PK]; outputs
 *  [pool, pool token, KAS leg (if any), token payout (if any), pool LP]. */
export function buildPoolV1RemoveLiquidity(k: K, tpl: PoolV1Template, utxo: PoolV1Utxo, lpInventory: LpInventoryUtxoV1, poolCovid: Uint8Array, lpCovid: Uint8Array, lpShares: TokenUtxoV1, lpPubkey: Uint8Array, opts: { tokenDust?: bigint; blake3?: Blake3 } = {}): CovenantSpendV1 & { quote: RemoveLiquidityQuote } {
  const dust = opts.tokenDust ?? COVENANT_DUST, blake3Of = opts.blake3 ?? noBlake3;
  if (hexOf(utxo.state.lpCovid) !== hexOf(lpCovid)) throw new Error('lpCovid does not match the pool state');
  const q = quoteRemoveLiquidity(utxo.state, { lockedShares: tpl.params.lockedShares }, lpShares.state.amount);
  if (lpInventory.amount !== MAX_SHARES - utxo.state.totalShares) throw new Error('LP inventory does not match the pool state');
  const { tokenCovid: A } = utxo.state; const ext = utxo.tokenUtxo.extensionCommitment ?? ZERO32, lpExt = lpInventory.extensionCommitment ?? ZERO32;
  const poolTokenOut = covenantOwnedV1(poolCovid, q.newToken, ext);
  const lpTokenOut = p2pkOwnedV1(lpPubkey, q.dToken > 0n ? q.dToken : 1n, ext); // dummy(1) when no token leg — the covenant ignores it
  const poolLpOut = covenantOwnedV1(poolCovid, MAX_SHARES - q.newShares, lpExt);
  const lpWitness = 4;
  const inputs: CovInputV1[] = [
    poolInput(k, tpl, utxo, poolCovid, 'removeLiquidity', [q.dShares, q.dKas, q.dToken, poolTokenOut, lpTokenOut, poolLpOut, BigInt(lpWitness), lpPubkey], (b) => { b.int(q.dShares).int(q.dKas).int(q.dToken); pushTokenStateV1(b, tpl.token.templateHash, poolTokenOut); pushTokenStateV1(b, tpl.token.templateHash, lpTokenOut); pushTokenStateV1(b, tpl.token.templateHash, poolLpOut); b.int(BigInt(lpWitness)).data(lpPubkey); }),
    poolOwnedLeader(k, tpl.token, utxo.tokenUtxo, utxo.state.tokenReserve, poolCovid, A, 'poolToken', q.dToken > 0n ? [poolTokenOut, lpTokenOut] : [poolTokenOut]),
    poolOwnedLeader(k, tpl.token, lpInventory, lpInventory.amount, poolCovid, lpCovid, 'lpInventory', [poolLpOut]),
    holderDelegator(k, tpl.token, lpShares, lpPubkey, lpCovid, 'lpShares', blake3Of),
  ];
  const outputs: CovOutputV1[] = [
    covOut(q.newKas * SCALE, poolV1Spk(k, materializePoolV1Script(tpl, { ...utxo.state, kasReserve: q.newKas, tokenReserve: q.newToken, totalShares: q.newShares })), 'pool', poolCovid, 0),
    covOut(continuationValue(dust, utxo.tokenUtxo.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, poolTokenOut)), 'poolToken', A, 1),
  ];
  if (q.dKas > 0n) outputs.push(feeOut(k, q.dKas * SCALE, lpPubkey, 'lpKas'));                          // REMOVE_KAS_OUT = 2
  if (q.dToken > 0n) outputs.push(covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, lpTokenOut)), 'lpToken', A, 1));
  outputs.push(covOut(continuationValue(dust, lpInventory.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, poolLpOut)), 'poolLp', lpCovid, 2));
  return { family: 'kcc20v1', kind: 'removeLiquidity', inputs, outputs, economics: { dShares: q.dShares, dKas: q.dKas, dToken: q.dToken }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(A), lpCovid: hexOf(lpCovid) }, quote: q };
}

/** bindLp: the pool mints its LP-share token (genesis at output 1, pool-owned inventory of MAX_SHARES − lockedShares). */
export function buildPoolV1BindLp(k: K, tpl: PoolV1Template, utxo: PoolV1Utxo, poolCovid: Uint8Array, opts: { lpDust?: bigint } = {}): CovenantSpendV1 {
  if (utxo.state.lpCovid.some(Boolean)) throw new Error('the pool already bound its LP token');
  if (utxo.state.totalShares !== tpl.params.lockedShares) throw new Error('bindLp runs on the freshly graduated pool (totalShares == lockedShares)');
  const dust = opts.lpDust ?? COVENANT_DUST;
  const lpInventory = covenantOwnedV1(poolCovid, MAX_SHARES - tpl.params.lockedShares);   // rule 2 + D6: zero extension
  const lpSpk = kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, lpInventory));
  const boundLp = genesisCovenantId(k, outpoint(utxo), [{ index: 1, value: dust, scriptPublicKey: lpSpk }]);
  const newState: PoolV1State = { ...utxo.state, lpCovid: covidToBytes(boundLp) };
  const inputs: CovInputV1[] = [poolInput(k, tpl, utxo, poolCovid, 'bindLp', [lpInventory, tpl.token.prefix, tpl.token.suffix], (b) => { pushTokenStateV1(b, tpl.token.templateHash, lpInventory); b.data(tpl.token.prefix).data(tpl.token.suffix); })];
  const outputs: CovOutputV1[] = [
    covOut(utxo.state.kasReserve * SCALE, poolV1Spk(k, materializePoolV1Script(tpl, newState)), 'pool', poolCovid, 0),
    covOut(dust, lpSpk, 'lpInventory', boundLp, 0),
  ];
  return { family: 'kcc20v1', kind: 'bindLp', inputs, outputs, economics: { lpInventory: lpInventory.amount }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(utxo.state.tokenCovid), lpCovid: boundLp } };
}
