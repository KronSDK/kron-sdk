// kcc20v1 (KCC-20 standard) family — pool builders (covenants/kcc20v1/pool_kcc20.sil). Twin of ./poolCpV3Tx.ts
// (frozen). Economics (quotes) are the audited pool's and are REUSED from ./poolCpTx.ts unchanged; what differs is
// the token model and the layouts PLAN.md §4 pins (docs/kcc20-spike/REPORT.md "Pool covenant"): the pool is input 0;
// its reserve piece is the token leader at input 1; the LP inventory is the leader among LP-token inputs; a holder's
// pieces are delegators; the holder's P2PK funding input follows the covenant inputs and is the witness index. A pool
// buy mints a NEW default holder piece (no merge — the covenant pins one token input); a sell takes ≤ 2 pieces and
// pays the KAS leg at output 4 with the change last; addLiquidity is laid out reserve(1) / deposit(2) / LP inventory(3).
// State span {1,93}: [08 kasReserve] [08 tokenReserve] [20 tokenCovid] [08 totalShares] [20 lpCovid].
// Two programs share these builders (audit KV1-05): LOCKED pool_kcc20.sil (graduation; THEN and GUZA) and OPEN
// pool_open_kcc20.sil (imported tokens' pools that lock nothing), told apart by the template's `program`; an OPEN pool binds
// with bindLpOpen, ends with closePool, pays exact deposits and leaves the creator slot to the trader when no fee is due.
import type { Kaspa } from '../wasm/kaspa.types.js';
import { SigScriptBuilder } from './sigscript.js';
import { continuationValue, COVENANT_DUST } from './covenantSelect.js';
import { SCALE, FEE_OUT_MIN } from '../curve/cpCurve.js';
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
/** pool_open_kcc20.sil MAX_SEED_SHARES: the bind sets the share count to the reserve in units, at most this (KV1-04). */
export const MAX_SEED_SHARES = 5_000_000n;
/** The least KAS an OPEN pool's withdrawal leaves in the pool output, and the least its KAS legs pay (topped up from the
 *  holder's own funds). Nothing is locked, so the last LP could drain the output to dust, and KIP-9 storage mass
 *  (≈ 1e12 / value per output) prices a 0.01 KAS output at 1,000,000, past the 500,000 cap: the tx would be invalid. */
export const OPEN_POOL_MIN_KAS_SOMPI = FEE_OUT_MIN;
const openLeg = (tpl: PoolV1Template, sompi: bigint): bigint => (isOpenPoolV1(tpl) && sompi < OPEN_POOL_MIN_KAS_SOMPI ? OPEN_POOL_MIN_KAS_SOMPI : sompi);
export type PoolProgramV1 = 'pool' | 'poolOpen';
const p2pkSpk = (k: K, pubkey: Uint8Array): Spk => { const sb = new (k as any).ScriptBuilder(); sb.addData(pubkey).addOp(172); return new (k as any).ScriptPublicKey(0, sb.drain()); };
const outpoint = (u: { transactionId: string; index: number }) => ({ transactionId: u.transactionId, index: u.index });
const hexToBytes = (h: string): Uint8Array => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
export type Blake3 = (b: Uint8Array) => Uint8Array;
const noBlake3: Blake3 = () => { throw new Error('a p2pkh-schnorr piece needs a BLAKE3 implementation (pass opts.blake3)'); };

/** Fixed per-pool parameters (baked by silverc) — the audited PoolCpParams shape, so the quotes apply unchanged. */
export type PoolV1Params = { creatorFeeOwner: Uint8Array; platformFeeOwner: Uint8Array; creatorFeeBps: bigint; platformFeeBps: bigint; lpFeeBps: bigint; lockedShares: bigint };
export type PoolV1Template = { prefix: Uint8Array; suffix: Uint8Array; templateHash: Uint8Array; tags: Record<string, Uint8Array>; params: PoolV1Params; token: Kcc20V1Template; program?: PoolProgramV1; bounds: PoolV1Bounds };
/** An OPEN pool (pool_open_kcc20.sil): nothing locked, lockedShares 0. */
export const isOpenPoolV1 = (tpl: Pick<PoolV1Template, 'program'>): boolean => tpl.program === 'poolOpen';
export type PoolV1State = { kasReserve: bigint; tokenReserve: bigint; tokenCovid: Uint8Array; totalShares: bigint; lpCovid: Uint8Array };
/** The live pool UTXO (value = kasReserve·SCALE) and its pool-owned token reserve piece. */
export type PoolV1Utxo = { transactionId: string; index: number; state: PoolV1State; tokenUtxo: { transactionId: string; index: number; value: bigint; extensionCommitment?: Uint8Array } };
/** The pool-owned LP-token inventory piece (amount = MAX_SHARES − totalShares). */
export type LpInventoryUtxoV1 = { transactionId: string; index: number; value: bigint; amount: bigint; extensionCommitment?: Uint8Array };
export type TokenUtxoV1 = { transactionId: string; index: number; value: bigint; state: Kcc20V1State };

export function poolTemplateFromCompiledV1(c: CompiledV1, params: PoolV1Params, token: Kcc20V1Template, program: PoolProgramV1 = 'pool', schema: string | null = null): PoolV1Template {
  const tags = assertFamilyTagsV1(program, c.dispatchTags);
  if (program === 'poolOpen' ? params.lockedShares !== 0n : params.lockedShares < 1n) throw new Error(program === 'poolOpen' ? 'an open pool has no locked shares (lockedShares must be 0)' : 'a LOCKED pool needs lockedShares >= 1 (0 is the open program)');
  if (c.stateSpan.offset !== 1 || c.stateSpan.len !== POOL_V1_STATE_LEN) throw new Error(`pool state span {${c.stateSpan.offset},${c.stateSpan.len}} is not {1,93}`);
  if (!c.bytecodeHex.includes(hexOf(token.templateHash))) throw new Error('this pool was not compiled against the given token template');
  return { prefix: c.prefix, suffix: c.suffix, templateHash: hexToBytes(c.templateHash), tags, params, token, program, bounds: poolBoundsV1(program, schema) };
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
  return { ...outpoint(utxo), value: utxo.state.kasReserve * SCALE, scriptPublicKey: poolV1Spk(k, redeem), redeem, covid: hexOf(poolCovid), role: 'pool', computeBudget: POOL_V1_COMPUTE, signatureScript: entrySig(k, tpl, entry, push, redeem), invocation: { program: tpl.program ?? 'pool', entry, args } };
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
/** The swap's creator slot (output 3 on a buy, 2 on a sell). KV1-03: an OPEN pool requires the creator leg only when a creator
 *  fee is due; otherwise the slot is the TRADER's own 0.2 KAS (same shape and mass as the leg it replaces, nothing transferred). */
const creatorSlot = (k: K, tpl: PoolV1Template, q: { creatorFee: bigint; creatorFloorRent?: bigint; creatorOut: bigint }, traderPubkey: Uint8Array): CovOutputV1 =>
  isOpenPoolV1(tpl) && q.creatorFee + (q.creatorFloorRent ?? 0n) === 0n ? feeOut(k, FEE_OUT_MIN, traderPubkey, 'traderSlot') : feeOut(k, q.creatorOut, tpl.params.creatorFeeOwner, 'creatorFee');
/** KV1-02: an OPEN pool takes exactly ceil(dShares·K/S) — the largest whole number of shares the KAS buys, paid at its price.
 *  The pair also satisfies the LOCKED rule (dShares is the floor for that dKas), so it never overpays either program. */
export function quoteAddLiquidityExactV1(state: Pick<PoolV1State, 'kasReserve' | 'tokenReserve' | 'totalShares'>, maxKasUnits: bigint): { dKas: bigint; dToken: bigint; dShares: bigint; newKas: bigint; newToken: bigint; newShares: bigint } | null {
  const K = state.kasReserve, T = state.tokenReserve, S = state.totalShares;
  if (K < 1n || T < 1n || S < 1n || maxKasUnits < 1n) return null;
  let dShares = (S * maxKasUnits) / K;
  if (dShares < 1n) return null;
  const dKas = (dShares * K + S - 1n) / S;
  dShares = (S * dKas) / K;
  const dToken = (T * dShares + S - 1n) / S;
  if (dToken < 1n) return null;
  return { dKas, dToken, dShares, newKas: K + dKas, newToken: T + dToken, newShares: S + dShares };
}

/** The family pool programs' reserve bounds (MAX_UNITS / MAX_TOKEN). They count raw units, and MAX_TOKEN is per program version,
 *  since a pool keeps the program it was created with: the LOCKED program and the OPEN one up to 6b7ec42cd29a hold 1e9, the OPEN
 *  one from de046fcd1374 holds 4e18. A sell's change piece is bounded by MAX_TOKEN as well. Pass a pool's own `templateSchema`
 *  to `poolTemplateFromCompiledV1`, or read its bounds here. */
export type PoolV1Bounds = { maxUnits: bigint; maxToken: bigint };
export const POOL_V1_MAX_UNITS = 900_000_000n;
export const POOL_V1_MAX_TOKEN_CAPPED = 1_000_000_000n;
export const POOL_V1_MAX_TOKEN_WIDE = 4_000_000_000_000_000_000n;
const CAPPED_OPEN_SCHEMAS_V1 = new Set(['6509b4fb3f38', 'aef9d6ae0e3d', '6b7ec42cd29a']);
/** The bounds of a program version. No `schema` = the current sources, the program a new pool is created on. */
export const poolBoundsV1 = (program: PoolProgramV1, schema?: string | null): PoolV1Bounds => ({
  maxUnits: POOL_V1_MAX_UNITS,
  maxToken: program === 'poolOpen' && !CAPPED_OPEN_SCHEMAS_V1.has(String(schema ?? '').toLowerCase().slice(0, 12)) ? POOL_V1_MAX_TOKEN_WIDE : POOL_V1_MAX_TOKEN_CAPPED,
});
type AddQuoteV1 = { dKas: bigint; dToken: bigint; dShares: bigint; newKas: bigint; newToken: bigint; newShares: bigint };
/** Whether an addLiquidity quote stays inside the program's bounds (the VM refuses it otherwise). */
export const addWithinBoundsV1 = (q: AddQuoteV1, b: PoolV1Bounds): boolean =>
  q.dKas <= b.maxUnits && q.dToken <= b.maxToken && q.dShares <= MAX_SHARES && q.newKas <= b.maxUnits && q.newToken <= b.maxToken && q.newShares < MAX_SHARES;
/** The largest deposit budget (KAS units) whose quote the pool still takes, or 0n when it is full. `quote` is the pool's own
 *  (quoteAddLiquidityExactV1 for an open pool, quoteAddLiquidityV1 for a locked one). */
export function maxAddKasUnitsV1<S extends Pick<PoolV1State, 'kasReserve' | 'tokenReserve' | 'totalShares'>>(state: S, b: PoolV1Bounds, quote: (s: S, d: bigint) => AddQuoteV1 | null = quoteAddLiquidityExactV1): bigint {
  const K = state.kasReserve, S = state.totalShares;
  if (K < 1n || state.tokenReserve < 1n || S < 1n || K >= b.maxUnits) return 0n;
  const fits = (d: bigint): boolean => { try { const q = quote(state, d); return !!q && addWithinBoundsV1(q, b); } catch { return false; } };
  let lo = (K + S - 1n) / S, hi = b.maxUnits - K; // lo: the least budget that mints one share
  if (lo > hi || !fits(lo)) return 0n;
  while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (fits(mid)) lo = mid; else hi = mid - 1n; }
  return lo;
}
/** How many more raw token units a sell can put into the pool before its reserve passes MAX_TOKEN. */
export const sellRoomV1 = (state: Pick<PoolV1State, 'tokenReserve'>, b: PoolV1Bounds): bigint => (state.tokenReserve < b.maxToken ? b.maxToken - state.tokenReserve : 0n);

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
    creatorSlot(k, tpl, q, traderPubkey),
    feeOut(k, q.platformOut, tpl.params.platformFeeOwner, 'platformFee'),
  ];
  const creatorOut = outputs[3].role === 'traderSlot' ? 0n : q.creatorOut;
  return { family: 'kcc20v1', kind: 'swapKasForToken', inputs, outputs, economics: { kasIn: q.kasIn, tokenOut: q.tokenOut, creatorOut, platformOut: q.platformOut }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(A) }, quote: q };
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
    creatorSlot(k, tpl, q, traderPubkey),
    feeOut(k, q.platformOut, tpl.params.platformFeeOwner, 'platformFee'),
    feeOut(k, kasLeg, traderPubkey, 'traderKas'),                                                     // SWAP_KAS_OUT = 4
  ];
  if (change > 0n) outputs.push(covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, traderChangeOut)), 'traderChange', A, 1));
  const creatorOut = outputs[2].role === 'traderSlot' ? 0n : q.creatorOut;
  return { family: 'kcc20v1', kind: 'swapTokenForKas', inputs, outputs, economics: { tokenIn, kasOut: q.kasOut, change, kasLeg, creatorOut, platformOut: q.platformOut }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(A) }, quote: q };
}

/** addLiquidity (D4 layout): inputs [pool, reserve, deposit (exactly dToken), LP inventory, LP P2PK]; outputs
 *  [pool, pool token, pool LP, LP shares]. */
export function buildPoolV1AddLiquidity(k: K, tpl: PoolV1Template, utxo: PoolV1Utxo, lpInventory: LpInventoryUtxoV1, poolCovid: Uint8Array, lpCovid: Uint8Array, deposit: TokenUtxoV1, lpPubkey: Uint8Array, dKas: bigint, opts: { tokenDust?: bigint; blake3?: Blake3 } = {}): CovenantSpendV1 & { quote: AddLiquidityQuote } {
  const dust = opts.tokenDust ?? COVENANT_DUST, blake3Of = opts.blake3 ?? noBlake3;
  if (!utxo.state.lpCovid.some(Boolean)) throw new Error('the pool has not bound its LP token yet (bindLp first)');
  if (hexOf(utxo.state.lpCovid) !== hexOf(lpCovid)) throw new Error('lpCovid does not match the pool state');
  const q = isOpenPoolV1(tpl) ? req(quoteAddLiquidityExactV1(utxo.state, dKas), 'addLiquidity') : quoteAddLiquidity(utxo.state, dKas);
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
  if (isOpenPoolV1(tpl) && lpShares.state.amount >= utxo.state.totalShares) throw new Error('withdrawing every share closes the pool (closePool), the last share never leaves through removeLiquidity');
  const q = quoteRemoveLiquidity(utxo.state, { lockedShares: tpl.params.lockedShares }, lpShares.state.amount);
  if (isOpenPoolV1(tpl) && q.newKas * SCALE < OPEN_POOL_MIN_KAS_SOMPI) throw new Error(`this withdrawal would leave ${q.newKas * SCALE} sompi in the pool, under ${OPEN_POOL_MIN_KAS_SOMPI} (KIP-9 storage mass): withdraw fewer shares, or close the pool with every share`);
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
  if (q.dKas > 0n) outputs.push(feeOut(k, openLeg(tpl, q.dKas * SCALE), lpPubkey, 'lpKas'));            // REMOVE_KAS_OUT = 2
  if (q.dToken > 0n) outputs.push(covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, lpTokenOut)), 'lpToken', A, 1));
  outputs.push(covOut(continuationValue(dust, lpInventory.value), kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, poolLpOut)), 'poolLp', lpCovid, 2));
  return { family: 'kcc20v1', kind: 'removeLiquidity', inputs, outputs, economics: { dShares: q.dShares, dKas: q.dKas, dToken: q.dToken }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(A), lpCovid: hexOf(lpCovid) }, quote: q };
}

/** The pool's genesis state for a STANDALONE pool (S17): reserves k0 / t0, every share locked, no LP token yet. */
export const poolV1GenesisState = (tpl: PoolV1Template, tokenCovid: Uint8Array, k0: bigint, t0: bigint): PoolV1State =>
  ({ kasReserve: k0, tokenReserve: t0, tokenCovid, totalShares: isOpenPoolV1(tpl) ? openSeedSharesV1(k0) : tpl.params.lockedShares, lpCovid: ZERO32 });
/** An OPEN pool's share count at the bind (and, canonically, at genesis): the reserve in units, capped (KV1-04). */
export const openSeedSharesV1 = (kasReserve: bigint): bigint => (kasReserve < MAX_SEED_SHARES ? kasReserve : MAX_SEED_SHARES);

/**
 * S17 — standalone pool GENESIS for an imported KCC-20 standard token (the family twin of poolCpTx.buildPoolGenesis;
 * docs/kcc20v1/SEGMENTS.md S17 step 2). ONE transaction creates the pool covenant P at the state
 * `{ kasReserve k0, tokenReserve t0, tokenCovid A, totalShares == lockedShares, lpCovid ZERO }` and moves the seeder's
 * token pieces into P's reserve through the token program's own `transfer` (leader = the seeder's first piece, successor
 * = a P-owned state under scheme 0x04 with borrowing disabled and a zero guard — PLAN §4 rule 2; the seeder's change, when
 * any, copies their own settings — rule 4). Every rule the pool enforces fires on the first spend (swap / bindLp), exactly
 * as a graduation pool's do; genesis is plain output creation.
 *
 * Layout = the audited external pool's: the seeder's LEADER piece (input 0) authorizes BOTH the pool genesis (output 0)
 * and the covid-A continuations, so P = KIP-20 genesis id over the leader's outpoint and the pool output, known before
 * any funding is selected. Consensus counts only CONTINUATION outputs in an input's authorized set (rusty-kaspa
 * txscript covenants.rs `from_tx`: genesis outputs are validated by id reconstruction and never enter the script-engine
 * contexts), so the token program's `OpCovOutputCount(A) == OpAuthOutputCount(leader)` holds — verify:standalone-pool-v1
 * executes this layout on both known builds.
 *   inputs  [0] seeder piece (KCC-20 leader: `transfer`), [1] optional second piece (delegator); funding appended after
 *   outputs [0] pool P (value k0·SCALE), [1] P-owned reserve t0 (A), [2] seeder change (A) when the pieces exceed t0 —
 *           all three authorized by input 0.
 */
export function buildPoolV1Genesis(k: K, tpl: PoolV1Template, tokenCovid: Uint8Array, pieces: TokenUtxoV1[], seederPubkey: Uint8Array, k0: bigint, t0: bigint, opts: { tokenDust?: bigint; blake3?: Blake3 } = {}): CovenantSpendV1 & { poolCovidHex: string; state: PoolV1State; poolSpk: Spk } {
  const dust = opts.tokenDust ?? COVENANT_DUST, blake3Of = opts.blake3 ?? noBlake3;
  if (tokenCovid.length !== 32 || tokenCovid.every((b) => b === 0)) throw new Error('tokenCovid must be a non-zero 32-byte covenant id');
  if (pieces.length < 1 || pieces.length > MAX_TRADER_PIECES) throw new Error(`a pool genesis spends 1..${MAX_TRADER_PIECES} of the seeder's pieces`);
  if (k0 < 1n || k0 > tpl.bounds.maxUnits) throw new Error(`k0 must be 1..${tpl.bounds.maxUnits} KAS units (SCALE 1e6 sompi)`);
  if (t0 < 1n || t0 > tpl.bounds.maxToken) throw new Error(`t0 must be 1..${tpl.bounds.maxToken} raw token units`);
  const locked = tpl.params.lockedShares;
  if (!isOpenPoolV1(tpl) && (locked < 1n || locked >= MAX_SHARES)) throw new Error('lockedShares must be 1..MAX_SHARES-1 (bindLp requires it)');
  for (const p of pieces) assertHolderPieceV1(p.state, seederPubkey, blake3Of);
  const total = pieces.reduce((s, p) => s + p.state.amount, 0n);
  if (total < t0) throw new Error(`the seeder's pieces hold ${total}, less than the ${t0} to seed`);
  const state = poolV1GenesisState(tpl, tokenCovid, k0, t0);
  const poolSpk = poolV1Spk(k, materializePoolV1Script(tpl, state));
  const poolCovidHex = genesisCovenantId(k, outpoint(pieces[0]), [{ index: 0, value: k0 * SCALE, scriptPublicKey: poolSpk }]);
  const P = covidToBytes(poolCovidHex);
  if (hexOf(P) === hexOf(tokenCovid)) throw new Error('pool covenant id collides with the token covenant id');
  const first = pieces[0].state, ext = first.extensionCommitment;
  const reserve = covenantOwnedV1(P, t0, ext);                                   // rule 2 + D6: borrow disabled, zero guard
  const change = total - t0;
  const nextStates: Kcc20V1State[] = change > 0n ? [reserve, changeLikeV1(first, change, ext)] : [reserve];
  const leaderRedeem = materializeKcc20V1Script(tpl.token, first);
  const leaderWith = (sig65: Uint8Array) => transferSigScriptV1(k, tpl.token, leaderRedeem, nextStates, leaderWitnessV1(authorityV1(first, sig65, seederPubkey)));
  const inputs: CovInputV1[] = [{
    ...outpoint(pieces[0]), value: pieces[0].value, scriptPublicKey: kcc20V1Spk(k, leaderRedeem), redeem: leaderRedeem, covid: hexOf(tokenCovid), role: 'seederLeader', computeBudget: TOKEN_V1_COMPUTE,
    signatureScript: leaderWith(SIG65_PLACEHOLDER), invocation: { program: 'token', entry: 'transfer', args: [nextStates, leaderWitnessV1(authorityV1(first, SIG65_PLACEHOLDER, seederPubkey))] },
    sign: { holderPubkey: seederPubkey, ownerScheme: first.ownerScheme, withSignature: leaderWith },
  }];
  for (const piece of pieces.slice(1)) inputs.push(holderDelegator(k, tpl.token, piece, seederPubkey, tokenCovid, 'seederDelegator', blake3Of));
  const outputs: CovOutputV1[] = [
    covOut(k0 * SCALE, poolSpk, 'pool', P, 0),
    covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, reserve)), 'poolToken', tokenCovid, 0),
  ];
  if (change > 0n) outputs.push(covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, nextStates[1])), 'seederChange', tokenCovid, 0));
  return { family: 'kcc20v1', kind: 'poolGenesis', inputs, outputs, economics: { k0, t0, change, pieces: BigInt(pieces.length), lockedShares: locked }, covids: { poolCovid: poolCovidHex, tokenCovid: hexOf(tokenCovid) }, poolCovidHex, state, poolSpk };
}

/** bindLp: the pool mints its LP-share token (genesis at output 1, pool-owned inventory of MAX_SHARES − lockedShares). */
export function buildPoolV1BindLp(k: K, tpl: PoolV1Template, utxo: PoolV1Utxo, poolCovid: Uint8Array, opts: { lpDust?: bigint } = {}): CovenantSpendV1 {
  if (isOpenPoolV1(tpl)) return buildPoolV1BindLpOpen(k, tpl, utxo, poolCovid, opts);
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

/** bindLpOpen (OPEN pools): L's genesis is the pool-owned inventory (MAX_SHARES − seed) at output 1 and the seeder's whole
 *  initial position at output 2 — `seed` = the reserve in units, capped (KV1-04) — owned by creatorFeeOwner, the seeder. */
export function buildPoolV1BindLpOpen(k: K, tpl: PoolV1Template, utxo: PoolV1Utxo, poolCovid: Uint8Array, opts: { lpDust?: bigint } = {}): CovenantSpendV1 {
  if (!isOpenPoolV1(tpl)) throw new Error('bindLpOpen is the OPEN pool\'s bind');
  if (utxo.state.lpCovid.some(Boolean)) throw new Error('the pool already bound its LP token');
  const dust = opts.lpDust ?? COVENANT_DUST;
  const seed = openSeedSharesV1(utxo.state.kasReserve);
  if (seed < 1n) throw new Error('an empty pool cannot bind');
  const lpInventory = covenantOwnedV1(poolCovid, MAX_SHARES - seed);                       // rule 2 + D6: zero extension
  const seedShares = p2pkOwnedV1(tpl.params.creatorFeeOwner, seed);                       // rule 3: the seeder's position
  const invSpk = kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, lpInventory)), seedSpk = kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, seedShares));
  const boundLp = genesisCovenantId(k, outpoint(utxo), [{ index: 1, value: dust, scriptPublicKey: invSpk }, { index: 2, value: dust, scriptPublicKey: seedSpk }]);
  const newState: PoolV1State = { ...utxo.state, totalShares: seed, lpCovid: covidToBytes(boundLp) };
  const inputs: CovInputV1[] = [poolInput(k, tpl, utxo, poolCovid, 'bindLpOpen', [lpInventory, seedShares, tpl.token.prefix, tpl.token.suffix], (b) => { pushTokenStateV1(b, tpl.token.templateHash, lpInventory); pushTokenStateV1(b, tpl.token.templateHash, seedShares); b.data(tpl.token.prefix).data(tpl.token.suffix); })];
  const outputs: CovOutputV1[] = [
    covOut(utxo.state.kasReserve * SCALE, poolV1Spk(k, materializePoolV1Script(tpl, newState)), 'pool', poolCovid, 0),
    covOut(dust, invSpk, 'lpInventory', boundLp, 0),
    covOut(dust, seedSpk, 'seedShares', boundLp, 0),
  ];
  return { family: 'kcc20v1', kind: 'bindLpOpen', inputs, outputs, economics: { lpInventory: lpInventory.amount, seedShares: seed }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(utxo.state.tokenCovid), lpCovid: boundLp } };
}

/** closePool (OPEN pools): the holder of EVERY outstanding share — one piece of exactly totalShares (merge first) — takes the
 *  whole pool and ends it. Inputs [pool, reserve (A leader), LP inventory (L leader), the holder's L piece, the holder's P2PK
 *  at 4]; outputs [the whole KAS reserve at 0 (at least OPEN_POOL_MIN_KAS_SOMPI, topped up from the holder's funds), the whole
 *  token reserve as a new piece (authorized by 1), the retired L piece of MAX_SHARES (authorized by 2)]. L cannot be burned;
 *  with the pool gone the retired piece redeems nothing. */
export function buildPoolV1ClosePool(k: K, tpl: PoolV1Template, utxo: PoolV1Utxo, lpInventory: LpInventoryUtxoV1, poolCovid: Uint8Array, lpCovid: Uint8Array, lpShares: TokenUtxoV1, lpPubkey: Uint8Array, opts: { tokenDust?: bigint; blake3?: Blake3 } = {}): CovenantSpendV1 {
  if (!isOpenPoolV1(tpl)) throw new Error('only an OPEN pool can be closed (a LOCKED pool keeps its floor forever)');
  const dust = opts.tokenDust ?? COVENANT_DUST, blake3Of = opts.blake3 ?? noBlake3;
  if (hexOf(utxo.state.lpCovid) !== hexOf(lpCovid) || !lpCovid.some(Boolean)) throw new Error('lpCovid does not match the pool state');
  if (lpShares.state.amount !== utxo.state.totalShares) throw new Error(`closing needs every outstanding share in one piece (${utxo.state.totalShares}); this piece holds ${lpShares.state.amount} — merge your LP pieces first, or withdraw part instead`);
  if (lpInventory.amount !== MAX_SHARES - utxo.state.totalShares) throw new Error('LP inventory does not match the pool state');
  const { tokenCovid: A } = utxo.state; const ext = utxo.tokenUtxo.extensionCommitment ?? ZERO32, lpExt = lpInventory.extensionCommitment ?? ZERO32;
  const tokenPayout = p2pkOwnedV1(lpPubkey, utxo.state.tokenReserve, ext);
  const retired = p2pkOwnedV1(lpPubkey, MAX_SHARES, lpExt);
  const lpWitness = 4;
  const inputs: CovInputV1[] = [
    poolInput(k, tpl, utxo, poolCovid, 'closePool', [tokenPayout, retired, BigInt(lpWitness), lpPubkey], (b) => { pushTokenStateV1(b, tpl.token.templateHash, tokenPayout); pushTokenStateV1(b, tpl.token.templateHash, retired); b.int(BigInt(lpWitness)).data(lpPubkey); }),
    poolOwnedLeader(k, tpl.token, utxo.tokenUtxo, utxo.state.tokenReserve, poolCovid, A, 'poolToken', [tokenPayout]),
    poolOwnedLeader(k, tpl.token, lpInventory, lpInventory.amount, poolCovid, lpCovid, 'lpInventory', [retired]),
    holderDelegator(k, tpl.token, lpShares, lpPubkey, lpCovid, 'lpShares', blake3Of),
  ];
  const outputs: CovOutputV1[] = [
    feeOut(k, openLeg(tpl, utxo.state.kasReserve * SCALE), lpPubkey, 'lpKas'),                     // CLOSE_KAS_OUT = 0
    covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, tokenPayout)), 'lpToken', A, 1),
    covOut(dust, kcc20V1Spk(k, materializeKcc20V1Script(tpl.token, retired)), 'retiredLp', lpCovid, 2),
  ];
  return { family: 'kcc20v1', kind: 'closePool', inputs, outputs, economics: { dShares: utxo.state.totalShares, dKas: utxo.state.kasReserve, dToken: utxo.state.tokenReserve }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(A), lpCovid: hexOf(lpCovid) } };
}
