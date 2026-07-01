// amm_pool_cp transaction builder — the graduated DEX pool with TWO-TIER liquidity. SHARED core: pool state
// layout, P2SH/address derivation, CP quotes, and the LP entrypoints (bindLp / addLiquidity / removeLiquidity),
// which are byte-identical across the pool covenant versions. The LIVE deployed covenant is amm_pool_cp_v3.sil
// (single-token swaps); its swap builders live in poolCpV3Tx.ts and reuse everything here.
//
// MODEL (see docs/lp-provision-design.md + amm_pool_cp_v3.sil):
//   • Graduation seeds a PERMANENTLY-LOCKED floor (`lockedShares`); on top, anyone can add/remove VOLUNTARY
//     liquidity and earn swap fees. LP shares follow KRON's INVENTORY model (a pre-minted kcc20 token `L`,
//     pool holds the unissued shares; add/remove MOVE shares, never mint/burn).
//   • 5-field pool state {kasReserve(SCALE units), tokenReserve, tokenCovid, totalShares, lpCovid}.
//   • Post-grad fee (option ii): creator base + the floor's share of the LP fee paid OUT to the creator
//     (creatorFloorRent = lpFee·lockedShares/totalShares); the voluntary share stays in-pool (k grows).
//
// SECURITY: the pool owns TWO covenant tokens (A reserve + L inventory), both covenant-id-owned. Every
// entrypoint fully constrains BOTH groups — swaps forbid any L movement; add/remove validate the exact moves.
//
// Reuses the kcc20 template/helpers (token A AND the LP-share token L share the SAME kcc20 contract — only
// the covid differs). No top-level SDK import — caller passes the loaded WASM `k`.
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
import { FEE_OUT_MIN, SCALE } from '../curve/cpCurve.js';
import type { CovenantSpend, CovInput, CovOutput } from './spend.js';

type K = Kaspa;
type Spk = any;

/** pool entrypoint selectors (declaration order in amm_pool_cp_v3.sil). */
export const POOL_CP_SELECTOR = { swapKasForToken: 0, swapTokenForKas: 1, addLiquidity: 2, removeLiquidity: 3, bindLp: 4 } as const;
/** the LP-share token's FIXED total supply S_MAX (== MAX_SHARES in amm_pool_cp_v3.sil). */
export const MAX_SHARES = 10_000_000n;
/** the all-zero covenant id — the bindLp floor owner (unspendable) and the unbound `lpCovid` placeholder. */
const ZERO32 = new Uint8Array(32);

const padFee = (f: bigint) => (f > FEE_OUT_MIN ? f : FEE_OUT_MIN);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const hexOf = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

// --- pool state (5 fields) + redeem-script splice -------------------------------------------
// silverc state_layout {start, len:93}:
//   off 0: 0x08 <kasReserve:8 LE>   off 9: 0x08 <tokenReserve:8 LE>   off 18: 0x20 <tokenCovid:32>
//   off 51: 0x08 <totalShares:8 LE> off 60: 0x20 <lpCovid:32>

/** Compiled pool template (silverc output; one template per (lockedShares,bps...) — only state varies). */
export type PoolCpTemplate = { script: Uint8Array; stateStart: number };

/** Pool state: KAS reserve (SCALE units; pool UTXO value == kasReserve·SCALE), token reserve, the token
 *  covid A, issued LP shares, and the LP-share token covid L (ZERO until bindLp). */
export type PoolCpState = {
  kasReserve: bigint;
  tokenReserve: bigint;
  tokenCovid: Uint8Array;
  totalShares: bigint;
  lpCovid: Uint8Array;
};

/** Produce the pool redeem script for `state` by splicing the 93-byte region. Byte-identical to silverc. */
export function materializePoolCpScript(tpl: PoolCpTemplate, state: PoolCpState): Uint8Array {
  const s = tpl.stateStart;
  const t = tpl.script;
  if (t[s] !== 0x08 || t[s + 9] !== 0x08 || t[s + 18] !== 0x20 || t[s + 51] !== 0x08 || t[s + 60] !== 0x20) {
    throw new Error('pool template has an unexpected state layout (expected kasReserve/tokenReserve/tokenCovid/totalShares/lpCovid)');
  }
  if (state.kasReserve < 0n || state.tokenReserve < 0n || state.totalShares < 0n) throw new Error('reserves/shares must be non-negative');
  if (state.tokenCovid.length !== 32) throw new Error('tokenCovid must be 32 bytes');
  if (state.lpCovid.length !== 32) throw new Error('lpCovid must be 32 bytes');
  const out = t.slice();
  out[s] = 0x08;
  out.set(int8LE(state.kasReserve), s + 1);
  out[s + 9] = 0x08;
  out.set(int8LE(state.tokenReserve), s + 10);
  out[s + 18] = 0x20;
  out.set(state.tokenCovid, s + 19);
  out[s + 51] = 0x08;
  out.set(int8LE(state.totalShares), s + 52);
  out[s + 60] = 0x20;
  out.set(state.lpCovid, s + 61);
  return out;
}

export const poolCpSpk = (k: K, redeem: Uint8Array): Spk => (k as any).payToScriptHashScript(redeem);
export const poolCpSpkForState = (k: K, tpl: PoolCpTemplate, state: PoolCpState): Spk => poolCpSpk(k, materializePoolCpScript(tpl, state));
export function poolCpAddress(k: K, tpl: PoolCpTemplate, state: PoolCpState, network: string): string {
  return (k as any).addressFromScriptPublicKey(poolCpSpkForState(k, tpl, state), network)?.toString() ?? '';
}

const p2pkSpk = (k: any, pubkey: Uint8Array) => { const sb = new k.ScriptBuilder(); sb.addData(pubkey).addOp(172); return new k.ScriptPublicKey(0, sb.drain()); };

/** Fixed per-pool fee schedule (baked into the redeem script by silverc; the builder needs them for quotes). */
export type PoolCpParams = {
  creatorFeeOwner: Uint8Array;   // 32-byte x-only pubkey (P2PK): creator base fee + the floor's LP-fee share
  platformFeeOwner: Uint8Array;  // 32-byte x-only pubkey (P2PK): platform fee
  creatorFeeBps: bigint;         // e.g. 10 = 0.10%
  platformFeeBps: bigint;        // e.g. 5 = 0.05%
  lpFeeBps: bigint;              // e.g. 20 = 0.20%
  lockedShares: bigint;          // the permanently-locked floor shares (baked; == graduation totalShares)
};

/** The live pool UTXO (value = kasReserve·SCALE) + its P-owned token-A reserve UTXO. */
export type PoolCpUtxo = {
  transactionId: string;
  index: number;
  state: PoolCpState;
  /** the pool's token-A reserve UTXO (kcc20 owned by the pool covid P, amount = tokenReserve). */
  tokenUtxo: { transactionId: string; index: number; value: bigint };
};

/** The pool's P-owned LP-share (L) inventory UTXO (amount = the unissued shares the pool holds). */
export type PoolLpInventoryUtxo = { transactionId: string; index: number; value: bigint; amount: bigint };

// =================================================================================================
// swaps (with the option-ii floor-rent fee + voluntary-yield k-growth)
// =================================================================================================

export type PoolCpBuyQuote = {
  kasInUnits: bigint; kasIn: bigint; tokenOut: bigint;
  creatorFee: bigint; creatorFloorRent: bigint; platformFee: bigint; lpFee: bigint;
  creatorOut: bigint; platformOut: bigint; total: bigint; newKas: bigint; newToken: bigint;
};
export type PoolCpSellQuote = {
  tokenIn: bigint; kasOutUnits: bigint; kasOut: bigint;
  creatorFee: bigint; creatorFloorRent: bigint; platformFee: bigint; lpFee: bigint;
  creatorOut: bigint; platformOut: bigint; net: bigint; newKas: bigint; newToken: bigint;
};

/** The voluntary share of the LP fee, in bps, that must stay in the pool (k-growth) — matches the covenant. */
function lpRetainBps(state: PoolCpState, p: PoolCpParams): bigint {
  return (p.lpFeeBps * (state.totalShares - p.lockedShares)) / state.totalShares;
}

/** Buy from the pool: spend `kasInSompi` (floored to a SCALE step) → tokenOut, retaining the voluntary LP fee in-pool. */
export function quotePoolCpBuy(state: PoolCpState, p: PoolCpParams, kasInSompi: bigint): PoolCpBuyQuote | null {
  const kasInUnits = kasInSompi / SCALE; const kasIn = kasInUnits * SCALE;
  if (kasInUnits <= 0n) return null;
  const newKas = state.kasReserve + kasInUnits;
  const oldK = state.kasReserve * state.tokenReserve;
  // Retain the voluntary share of THIS trade's LP fee in-pool — trade-proportional, mirroring the covenant EXACTLY:
  // (newKas − retainKas)·newToken ≥ oldK, so the most tokenOut comes from newToken = ceil(oldK / (newKas − retainKas)).
  const retainKas = (kasInUnits * lpRetainBps(state, p)) / 10000n;
  const effKas = newKas - retainKas;
  if (effKas <= 0n) return null;
  const newToken = ceilDiv(oldK, effKas);
  const tokenOut = state.tokenReserve - newToken;
  if (tokenOut <= 0n) return null;
  const creatorFee = (kasIn * p.creatorFeeBps) / 10000n;
  const platformFee = (kasIn * p.platformFeeBps) / 10000n;
  const lpFee = (kasIn * p.lpFeeBps) / 10000n;
  const creatorFloorRent = (lpFee * p.lockedShares) / state.totalShares;
  const creatorOut = padFee(creatorFee + creatorFloorRent);
  const platformOut = padFee(platformFee);
  return { kasInUnits, kasIn, tokenOut, creatorFee, creatorFloorRent, platformFee, lpFee, creatorOut, platformOut, total: kasIn + creatorOut + platformOut, newKas, newToken };
}

/** Sell to the pool: fold `tokenIn` tokens in → kasOut sompi (a SCALE step), retaining the voluntary LP fee in-pool. */
export function quotePoolCpSell(state: PoolCpState, p: PoolCpParams, tokenIn: bigint): PoolCpSellQuote | null {
  if (tokenIn <= 0n) return null;
  const newToken = state.tokenReserve + tokenIn;
  const oldK = state.kasReserve * state.tokenReserve;
  const r = lpRetainBps(state, p);
  // The covenant requires (kasReserve − kasOut − floor(kasOut·r/1e4))·newToken ≥ oldK. Pick the LARGEST kasOut that
  // clears it: kasOut + floor(kasOut·r/1e4) ≤ kasReserve − ceil(oldK/newToken). Closed-form start, then ±1-adjust for
  // the floor() so we land on EXACTLY the covenant's max (never over-ask the VM rejects, never under-pay the trader).
  const effMin = ceilDiv(oldK, newToken);
  const budget = state.kasReserve - effMin;
  if (budget <= 0n) return null;
  const g = (x: bigint) => x + (x * r) / 10000n;
  let kasOutUnits = (budget * 10000n) / (10000n + r);
  while (kasOutUnits > 0n && g(kasOutUnits) > budget) kasOutUnits -= 1n;
  while (g(kasOutUnits + 1n) <= budget) kasOutUnits += 1n;
  const newKas = state.kasReserve - kasOutUnits;
  if (kasOutUnits <= 0n || newKas < 1n) return null;
  const kasOut = kasOutUnits * SCALE;
  const creatorFee = (kasOut * p.creatorFeeBps) / 10000n;
  const platformFee = (kasOut * p.platformFeeBps) / 10000n;
  const lpFee = (kasOut * p.lpFeeBps) / 10000n;
  const creatorFloorRent = (lpFee * p.lockedShares) / state.totalShares;
  const creatorOut = padFee(creatorFee + creatorFloorRent);
  const platformOut = padFee(platformFee);
  return { tokenIn, kasOutUnits, kasOut, creatorFee, creatorFloorRent, platformFee, lpFee, creatorOut, platformOut, net: kasOut - creatorOut - platformOut, newKas, newToken };
}

// =================================================================================================
// addLiquidity / removeLiquidity (inventory moves of L; two-sided A/KAS at the current ratio)
// =================================================================================================

export type AddLiquidityQuote = { dKas: bigint; dToken: bigint; dShares: bigint; newKas: bigint; newToken: bigint; newShares: bigint };
export type RemoveLiquidityQuote = { dShares: bigint; dKas: bigint; dToken: bigint; newKas: bigint; newToken: bigint; newShares: bigint };

/** The smallest deposit (in SCALE units) that mints ≥ 1 LP share at the current ratio. The covenant floors
 *  dShares = floor(totalShares·dKas/kasReserve), so dShares ≥ 1 ⟺ dKas ≥ ceil(kasReserve/totalShares). ANY dKas
 *  at/above this deposits — the old exact-integer lcm "step" (which could force a near-whole-pool minimum when the
 *  reserves were coprime to totalShares) is gone now that addLiquidity is floored like removeLiquidity. */
export function addMinDKas(state: PoolCpState): bigint {
  return (state.kasReserve + state.totalShares - 1n) / state.totalShares; // ceil(kasReserve/totalShares)
}

/** Clamp a desired `dKas` to a valid deposit: unchanged if ≥ the minimum (see addMinDKas), else 0 (too small to
 *  mint an integer share). No down-stepping — every value at/above the min is valid now that the covenant floors. */
export function snapAddDKas(state: PoolCpState, desiredDKas: bigint): bigint {
  const min = addMinDKas(state);
  if (min <= 0n || desiredDKas < min) return 0n;
  return desiredDKas;
}

/** Size a balanced deposit from `dKas` (SCALE units), FLOORED to match the covenant: dShares =
 *  floor(totalShares·dKas/kasReserve) (the depositor never gets more than their KAS-contribution fraction, so
 *  existing LPs aren't diluted), dToken = ceil(tokenReserve·dShares/totalShares) (they supply ≥ the proportional
 *  token). Any dKas ≥ addMinDKas works; throws only if dKas rounds to 0 shares. */
export function quoteAddLiquidity(state: PoolCpState, dKas: bigint): AddLiquidityQuote {
  if (dKas <= 0n) throw new Error('dKas must be positive');
  const dShares = (state.totalShares * dKas) / state.kasReserve; // floor
  if (dShares <= 0n) throw new Error('dKas too small to mint an integer LP share (snap with snapAddDKas / addMinDKas first)');
  const dToken = (state.tokenReserve * dShares + state.totalShares - 1n) / state.totalShares; // ceil(tokenReserve·dShares/totalShares)
  return { dKas, dToken, dShares, newKas: state.kasReserve + dKas, newToken: state.tokenReserve + dToken, newShares: state.totalShares + dShares };
}

/** The smallest withdrawable dShares — the floored covenant only needs the payout to round to ≥ 1 on BOTH sides
 *  (dKas ≥ 1 ⟺ dShares ≥ ⌈totalShares/kasReserve⌉; dToken ≥ 1 likewise). No exact-integer "step" exists anymore,
 *  so any dShares at/above this withdraws (the old lcm-step that could strand a voluntary LP is gone). */
export function removeMinDShares(state: PoolCpState): bigint {
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  const minKas = ceilDiv(state.totalShares, state.kasReserve);
  const minTok = ceilDiv(state.totalShares, state.tokenReserve);
  return minKas > minTok ? minKas : minTok;
}

/** Clamp a desired `dShares` to a withdrawable amount: returns it unchanged if ≥ the minimum (see removeMinDShares),
 *  else 0 (too small to round to ≥ 1 of either side). No down-stepping — every value at/above the min is valid. */
export function snapRemoveDShares(state: PoolCpState, desiredDShares: bigint): bigint {
  if (desiredDShares <= 0n || desiredDShares < removeMinDShares(state)) return 0n;
  return desiredDShares;
}

/** Compute a FLOORED-proportional withdrawal for `dShares` (matches the covenant): dKas/dToken are floored, so
 *  the sub-unit remainder stays in the pool. Throws only if dShares is non-positive, would dip below the locked
 *  floor (totalShares − dShares < lockedShares), or is so small the floored payout rounds to < 1 of either side. */
export function quoteRemoveLiquidity(state: PoolCpState, p: Pick<PoolCpParams, 'lockedShares'>, dShares: bigint): RemoveLiquidityQuote {
  if (dShares <= 0n) throw new Error('dShares must be positive');
  if (state.totalShares - dShares < p.lockedShares) throw new Error('removal would dip below the permanently-locked floor');
  const dKas = (state.kasReserve * dShares) / state.totalShares;     // bigint division floors (positives)
  const dToken = (state.tokenReserve * dShares) / state.totalShares;
  if (dKas < 1n || dToken < 1n) throw new Error('withdrawal too small — rounds to less than 1 KAS-unit or 1 token');
  return { dShares, dKas, dToken, newKas: state.kasReserve - dKas, newToken: state.tokenReserve - dToken, newShares: state.totalShares - dShares };
}

function addLiquiditySig(k: K, redeem: Uint8Array, dKas: bigint, dToken: bigint, dShares: bigint, poolTokenOut: Kcc20State, poolLpOut: Kcc20State, lpSharesOut: Kcc20State): string {
  const b = new SigScriptBuilder(k).int(dKas).int(dToken).int(dShares);
  pushKcc20StateScalar(b, poolTokenOut); pushKcc20StateScalar(b, poolLpOut); pushKcc20StateScalar(b, lpSharesOut);
  return b.selector(POOL_CP_SELECTOR.addLiquidity).redeem(redeem).drain();
}
function removeLiquiditySig(k: K, redeem: Uint8Array, dShares: bigint, dKas: bigint, dToken: bigint, poolTokenOut: Kcc20State, lpTokenOut: Kcc20State, poolLpOut: Kcc20State): string {
  const b = new SigScriptBuilder(k).int(dShares).int(dKas).int(dToken);
  pushKcc20StateScalar(b, poolTokenOut); pushKcc20StateScalar(b, lpTokenOut); pushKcc20StateScalar(b, poolLpOut);
  return b.selector(POOL_CP_SELECTOR.removeLiquidity).redeem(redeem).drain();
}

/**
 * addLiquidity — deposit dKas (SCALE units) + dToken at the current ratio, receive dShares of L moved out of
 * the pool's inventory. The LP must supply a token-A UTXO of EXACTLY dToken (full-UTXO deposit — the covenant
 * allows only ONE covid-A output, the grown pool reserve) and a co-present P2PK input at `presenceWitnessIdx`.
 *
 * Inputs:  [0]=pool [1]=LP token-A deposit(presence, =dToken) [2]=pool token-A reserve(P) [3]=pool L inventory(P)
 * Outputs: [0]=pool(grown) [1]=pool token-A reserve(P, newToken) [2]=reduced pool L inventory(P) [3]=LP dShares(presence)
 */
export function buildAddLiquidity(
  k: K, tpl: PoolCpTemplate, tokenTpl: Kcc20Template,
  utxo: PoolCpUtxo, lpInventory: PoolLpInventoryUtxo, poolCovid: Uint8Array,
  lpDepositToken: { transactionId: string; index: number; value: bigint; state: Kcc20State },
  lpPubkey: Uint8Array, q: AddLiquidityQuote, presenceWitnessIdx: number, opts: { tokenDust?: bigint } = {},
): CovenantSpend {
  if (lpDepositToken.state.amount !== q.dToken) throw new Error('LP deposit token UTXO must equal dToken exactly (split first)');
  const dust = opts.tokenDust ?? 1000n;
  const { kasReserve, tokenReserve, tokenCovid, lpCovid } = utxo.state;
  const poolTokenOut = covenantIdOwned(poolCovid, q.newToken, false);          // grown token-A reserve (P)
  const poolLpOut = covenantIdOwned(poolCovid, lpInventory.amount - q.dShares, false); // reduced L inventory (P)
  const lpSharesOut = addressPresenceOwned(lpPubkey, q.dShares);               // the LP's new shares (presence)

  const curRedeem = materializePoolCpScript(tpl, utxo.state);
  const newRedeem = materializePoolCpScript(tpl, { kasReserve: q.newKas, tokenReserve: q.newToken, tokenCovid, totalShares: q.newShares, lpCovid });
  const lpDepositRedeem = materializeKcc20Script(tokenTpl, lpDepositToken.state);
  const poolAResRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(poolCovid, tokenReserve, false));
  const poolLpInvRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(poolCovid, lpInventory.amount, false));

  // token-A group: inputs in tx order [LP deposit (input 1, presence), pool reserve (input 2, P)] → 1 output.
  const aStates = [poolTokenOut];
  const aWitnesses = [presenceWitnessIdx, 0];
  // L group: input [pool inventory (input 3, P)] → 2 outputs [reduced inventory, LP shares].
  const lStates = [poolLpOut, lpSharesOut];
  const lWitnesses = [0];

  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: kasReserve * SCALE, scriptPublicKey: poolCpSpk(k, curRedeem), signatureScript: addLiquiditySig(k, curRedeem, q.dKas, q.dToken, q.dShares, poolTokenOut, poolLpOut, lpSharesOut), redeem: curRedeem, role: 'pool' },
    { transactionId: lpDepositToken.transactionId, index: lpDepositToken.index, value: lpDepositToken.value, scriptPublicKey: kcc20Spk(k, lpDepositRedeem), signatureScript: transferSigScript(k, lpDepositRedeem, aStates, aWitnesses), redeem: lpDepositRedeem, role: 'lpDeposit' },
    { transactionId: utxo.tokenUtxo.transactionId, index: utxo.tokenUtxo.index, value: utxo.tokenUtxo.value, scriptPublicKey: kcc20Spk(k, poolAResRedeem), signatureScript: transferSigScript(k, poolAResRedeem, aStates, aWitnesses), redeem: poolAResRedeem, role: 'poolToken' },
    { transactionId: lpInventory.transactionId, index: lpInventory.index, value: lpInventory.value, scriptPublicKey: kcc20Spk(k, poolLpInvRedeem), signatureScript: transferSigScript(k, poolLpInvRedeem, lStates, lWitnesses), redeem: poolLpInvRedeem, role: 'poolLpInventory' },
  ];
  const outputs: CovOutput[] = [
    { value: q.newKas * SCALE, scriptPublicKey: poolCpSpk(k, newRedeem), role: 'pool' },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, poolTokenOut)), role: 'poolToken' },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, poolLpOut)), role: 'poolLpInventory' },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, lpSharesOut)), role: 'lpShares' },
  ];
  return { kind: 'addLiquidity', inputs, outputs, economics: { dKas: q.dKas, dToken: q.dToken, dShares: q.dShares, newShares: q.newShares }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(tokenCovid) } };
}

/**
 * removeLiquidity — return dShares of L to the pool inventory, withdraw a strictly-proportional dKas + dToken.
 * The withdrawn KAS is the tx change (the pool value drops by dKas·SCALE). The LP must supply an L UTXO of
 * EXACTLY dShares (full-UTXO) and a co-present P2PK input at `presenceWitnessIdx`. The covenant floor guard
 * (totalShares − dShares ≥ lockedShares) makes the graduation floor un-withdrawable.
 *
 * Inputs:  [0]=pool [1]=pool token-A reserve(P) [2]=LP L shares(presence, =dShares)
 * Outputs: [0]=pool(shrunk) [1]=pool token-A reserve(P, newToken) [2]=LP withdrawn token(presence, dToken)
 *          [3]=dShares returned to the pool L inventory(P)
 */
export function buildRemoveLiquidity(
  k: K, tpl: PoolCpTemplate, tokenTpl: Kcc20Template,
  utxo: PoolCpUtxo, lpShares: { transactionId: string; index: number; value: bigint; state: Kcc20State },
  poolCovid: Uint8Array, lpPubkey: Uint8Array, q: RemoveLiquidityQuote, presenceWitnessIdx: number, opts: { tokenDust?: bigint } = {},
): CovenantSpend {
  if (lpShares.state.amount !== q.dShares) throw new Error('LP shares UTXO must equal dShares exactly (split first)');
  const dust = opts.tokenDust ?? 1000n;
  const { kasReserve, tokenReserve, tokenCovid, lpCovid } = utxo.state;
  const poolTokenOut = covenantIdOwned(poolCovid, q.newToken, false);   // shrunk token-A reserve (P)
  const lpTokenOut = addressPresenceOwned(lpPubkey, q.dToken);          // the LP's withdrawn token (presence)
  const poolLpOut = covenantIdOwned(poolCovid, q.dShares, false);       // dShares returned to inventory (P)

  const curRedeem = materializePoolCpScript(tpl, utxo.state);
  const newRedeem = materializePoolCpScript(tpl, { kasReserve: q.newKas, tokenReserve: q.newToken, tokenCovid, totalShares: q.newShares, lpCovid });
  const poolAResRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(poolCovid, tokenReserve, false));
  const lpSharesRedeem = materializeKcc20Script(tokenTpl, lpShares.state);

  // token-A group: input [pool reserve (input 1, P)] → 2 outputs [shrunk reserve, LP withdrawn token].
  const aStates = [poolTokenOut, lpTokenOut];
  const aWitnesses = [0];
  // L group: input [LP shares (input 2, presence)] → 1 output [returned to pool inventory].
  const lStates = [poolLpOut];
  const lWitnesses = [presenceWitnessIdx];

  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: kasReserve * SCALE, scriptPublicKey: poolCpSpk(k, curRedeem), signatureScript: removeLiquiditySig(k, curRedeem, q.dShares, q.dKas, q.dToken, poolTokenOut, lpTokenOut, poolLpOut), redeem: curRedeem, role: 'pool' },
    { transactionId: utxo.tokenUtxo.transactionId, index: utxo.tokenUtxo.index, value: utxo.tokenUtxo.value, scriptPublicKey: kcc20Spk(k, poolAResRedeem), signatureScript: transferSigScript(k, poolAResRedeem, aStates, aWitnesses), redeem: poolAResRedeem, role: 'poolToken' },
    { transactionId: lpShares.transactionId, index: lpShares.index, value: lpShares.value, scriptPublicKey: kcc20Spk(k, lpSharesRedeem), signatureScript: transferSigScript(k, lpSharesRedeem, lStates, lWitnesses), redeem: lpSharesRedeem, role: 'lpShares' },
  ];
  const outputs: CovOutput[] = [
    { value: q.newKas * SCALE, scriptPublicKey: poolCpSpk(k, newRedeem), role: 'pool' },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, poolTokenOut)), role: 'poolToken' },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, lpTokenOut)), role: 'lpToken' },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, poolLpOut)), role: 'poolLpInventory' },
  ];
  return { kind: 'removeLiquidity', inputs, outputs, economics: { dShares: q.dShares, dKas: q.dKas, dToken: q.dToken, newShares: q.newShares }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(tokenCovid) } };
}

// =================================================================================================
// bindLp — one-time, permissionless genesis-mint of the LP-share token L + bind lpCovid into the pool
// =================================================================================================

/** The result of buildBindLp: the spend + the freshly-derived L covid + the inventory the pool now holds. */
export type BindLpResult = CovenantSpend & { lpCovidHex: string; lpInventoryAmount: bigint };

/**
 * bindLp — runs once on a freshly-graduated pool (lpCovid == ZERO, totalShares == lockedShares). Genesis-mints
 * the FIXED supply (MAX_SHARES) of the LP-share token L: the floor (lockedShares) is burned to an unspendable
 * ZERO-covid owner, the rest (MAX_SHARES − lockedShares) seeds the pool's inventory (owned by the pool covid
 * P). L carries NO minter branch → its supply is fixed forever (mint-renounced, like token A's init). The pool
 * continuation carries lpCovid = the new L genesis covid; value + reserves + totalShares are unchanged.
 *
 * Inputs:  [0]=pool (lpCovid == ZERO)
 * Outputs: [0]=pool(lpCovid bound) [1]=locked floor L(ZERO-owned, lockedShares) [2]=pool L inventory(P-owned)
 */
export function buildBindLp(
  k: K, tpl: PoolCpTemplate, tokenTpl: Kcc20Template,
  utxo: PoolCpUtxo, poolCovid: Uint8Array, lockedShares: bigint, opts: { tokenDust?: bigint } = {},
): BindLpResult {
  if (utxo.state.lpCovid.length !== 32 || !utxo.state.lpCovid.every((b) => b === 0)) throw new Error('pool lpCovid is already bound — bindLp is one-time');
  if (lockedShares < 1n || lockedShares >= MAX_SHARES) throw new Error('lockedShares out of range');
  if (utxo.state.totalShares !== lockedShares) throw new Error('bindLp requires totalShares == lockedShares (graduation state)');
  const dust = opts.tokenDust ?? 1000n;
  const { kasReserve, tokenReserve, tokenCovid } = utxo.state;
  const inventoryAmount = MAX_SHARES - lockedShares;
  const lpFloor = covenantIdOwned(ZERO32, lockedShares, false);              // floor → unspendable ZERO covid
  const lpInventory = covenantIdOwned(poolCovid, inventoryAmount, false);    // inventory → pool covid P

  const floorSpk = kcc20Spk(k, materializeKcc20Script(tokenTpl, lpFloor));
  const invSpk = kcc20Spk(k, materializeKcc20Script(tokenTpl, lpInventory));
  // L genesis covid = KIP-20 id over the pool UTXO outpoint (tx input 0) + the two L genesis outputs (idx 1,2).
  const lpCovidHex = genesisCovenantId(k, { transactionId: utxo.transactionId, index: utxo.index }, [
    { index: 1, value: dust, scriptPublicKey: floorSpk },
    { index: 2, value: dust, scriptPublicKey: invSpk },
  ]);
  const boundLp = covidToBytes(lpCovidHex);

  const curRedeem = materializePoolCpScript(tpl, utxo.state);
  const boundRedeem = materializePoolCpScript(tpl, { kasReserve, tokenReserve, tokenCovid, totalShares: lockedShares, lpCovid: boundLp });
  const poolValue = kasReserve * SCALE;

  const b = new SigScriptBuilder(k);
  pushKcc20StateScalar(b, lpFloor); pushKcc20StateScalar(b, lpInventory);
  const bindSig = b.selector(POOL_CP_SELECTOR.bindLp).redeem(curRedeem).drain();

  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: poolValue, scriptPublicKey: poolCpSpk(k, curRedeem), signatureScript: bindSig, redeem: curRedeem, role: 'pool' },
  ];
  const outputs: CovOutput[] = [
    { value: poolValue, scriptPublicKey: poolCpSpk(k, boundRedeem), role: 'pool' },
    { value: dust, scriptPublicKey: floorSpk, role: 'lpFloor' },
    { value: dust, scriptPublicKey: invSpk, role: 'lpInventory' },
  ];
  return { kind: 'bindLp', inputs, outputs, economics: { lockedShares, inventoryAmount }, covids: { poolCovid: hexOf(poolCovid), tokenCovid: hexOf(tokenCovid) }, lpCovidHex, lpInventoryAmount: inventoryAmount };
}
