// amm_pool_cp_v3 swap builders — SINGLE-TOKEN swaps (the LIVE deployed pool). Reuses the shared pool state,
// quotes, address derivation, and LP builders from poolCpTx.ts; only the two swap entrypoints differ.
//
// V3 (see docs/DESIGN-single-token-swaps.md): swaps are symmetric so every trade is ONE tx / ONE signature /
// ONE resulting token UTXO — no pre-split, no fragmentation.
//   • sell: the trader folds PART of a piece into the pool and gets the UNSOLD remainder back as one
//     presence-owned change output. covid-A outputs = [pool reserve] or [pool reserve, trader change(LAST)].
//   • buy: the trader may ALSO input their EXISTING token UTXO(s); the bought amount is merged into ONE output.
//
// The pool STATE layout, address derivation, and CP quotes are IDENTICAL to v2 — only the compiled script (and
// thus the P2SH address) differs, plus the swap tx in/out shapes. So this module REUSES the v2 state/quote/
// address helpers and only re-implements the two swap builders + the sell sig (which gains traderChangeOut).
import type { Kaspa } from '../wasm/kaspa.types.js';
import { SigScriptBuilder } from './sigscript.js';
import {
  type Kcc20State, type Kcc20Template,
  materializeKcc20Script, kcc20Spk, covenantIdOwned, addressPresenceOwned, pushKcc20StateScalar, transferSigScript,
} from './kcc20Tx.js';
import { SCALE } from '../curve/cpCurve.js';
import type { CovenantSpend, CovInput, CovOutput } from './spend.js';
import {
  type PoolCpTemplate, type PoolCpState, type PoolCpParams, type PoolCpUtxo,
  type PoolCpBuyQuote, type PoolCpSellQuote,
  materializePoolCpScript, poolCpSpk, poolCpAddress, poolCpSpkForState, quotePoolCpBuy, quotePoolCpSell,
} from './poolCpTx.js';

type K = Kaspa;

// v3 pool == v2 pool state/template/quote; only the script (P2SH address) + swap tx shapes differ. Aliases so
// callers can speak in v3 terms while the splice/derivation logic stays one battle-tested implementation.
export type PoolCpV3Template = PoolCpTemplate;
export type PoolCpV3State = PoolCpState;
export type PoolV3Params = PoolCpParams;
export type PoolCpV3Utxo = PoolCpUtxo;
export const materializePoolCpV3Script = materializePoolCpScript;
export const poolCpV3Spk = poolCpSpk;
export const poolCpV3SpkForState = poolCpSpkForState;
export const poolCpV3Address = poolCpAddress;
export const quotePoolV3Buy = quotePoolCpBuy;   // pricing is unchanged from v2 (merge is a tx-build concern)
export const quotePoolV3Sell = quotePoolCpSell; // `tokenIn` here is the amount FOLDED; change is a tx-build concern

/** v3 pool entrypoint selectors (same declaration order as v2). */
export const POOL_V3_SELECTOR = { swapKasForToken: 0, swapTokenForKas: 1, addLiquidity: 2, removeLiquidity: 3, bindLp: 4 } as const;

const hexOf = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const p2pkSpk = (k: any, pubkey: Uint8Array) => { const sb = new k.ScriptBuilder(); sb.addData(pubkey).addOp(172); return new k.ScriptPublicKey(0, sb.drain()); };

function v3SwapBuySig(k: K, redeem: Uint8Array, kasInUnits: bigint, tokenOut: bigint, poolTokenOut: Kcc20State, traderTokenOut: Kcc20State): string {
  const b = new SigScriptBuilder(k).int(kasInUnits).int(tokenOut);
  pushKcc20StateScalar(b, poolTokenOut); pushKcc20StateScalar(b, traderTokenOut);
  return b.selector(POOL_V3_SELECTOR.swapKasForToken).redeem(redeem).drain();
}
// v3 sell takes (kasOut, poolTokenOut, traderChangeOut) — the change state is pushed even on a full sell (the
// covenant only validates it when a 2nd covid-A output exists; otherwise it's an ignored placeholder).
function v3SwapSellSig(k: K, redeem: Uint8Array, kasOutUnits: bigint, poolTokenOut: Kcc20State, traderChangeOut: Kcc20State): string {
  const b = new SigScriptBuilder(k).int(kasOutUnits);
  pushKcc20StateScalar(b, poolTokenOut); pushKcc20StateScalar(b, traderChangeOut);
  return b.selector(POOL_V3_SELECTOR.swapTokenForKas).redeem(redeem).drain();
}

/** swapKasForToken (v3 — MERGE): buy `q.tokenOut`, optionally merging the buyer's EXISTING token UTXO(s)
 *  (`mergeTokens`, presence-owned, authorized by the co-present P2PK at `presenceWitnessIdx`) into ONE trader
 *  output of amount `tokenOut + Σ(existing)`. With no mergeTokens it's a plain buy. Outputs: [0]=pool [1]=pool
 *  token(P) [2]=trader token(presence, merged) [3]=creatorFee [4]=platformFee. kcc20 conservation pins the merge. */
export function buildPoolV3SwapKasForToken(
  k: K, tpl: PoolCpV3Template, tokenTpl: Kcc20Template, params: PoolV3Params,
  utxo: PoolCpV3Utxo, poolCovid: Uint8Array, traderPubkey: Uint8Array, q: PoolCpBuyQuote,
  mergeTokens: { transactionId: string; index: number; value: bigint; state: Kcc20State }[] = [],
  presenceWitnessIdx = 0, opts: { tokenDust?: bigint } = {},
): CovenantSpend {
  // Merge tokens are presence-owned: their kcc20 witness MUST be a co-present signed P2PK funding input.
  // Input 0 is the pool covenant (no signature), so the default 0 would fail the on-chain presence check.
  if (mergeTokens.length > 0 && presenceWitnessIdx === 0) throw new Error('presenceWitnessIdx must be set to a co-present signed P2PK funding input when mergeTokens is non-empty (input 0 is the pool covenant and carries no signature)');
  const dust = opts.tokenDust ?? 1000n;
  const { kasReserve, tokenReserve, tokenCovid, totalShares, lpCovid } = utxo.state;
  const poolCovidHex = hexOf(poolCovid);
  const tokenCovidHex = hexOf(tokenCovid);
  const mergeSum = mergeTokens.reduce((s, t) => s + t.state.amount, 0n);
  const poolTokenOut = covenantIdOwned(poolCovid, q.newToken, false);
  const traderTokenOut = addressPresenceOwned(traderPubkey, q.tokenOut + mergeSum);
  const curRedeem = materializePoolCpV3Script(tpl, utxo.state);
  const newRedeem = materializePoolCpV3Script(tpl, { kasReserve: q.newKas, tokenReserve: q.newToken, tokenCovid, totalShares, lpCovid });
  const poolTokInRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(poolCovid, tokenReserve, false));
  // covid-A inputs: pool token (witness=pool input 0), then each merged existing token (presence → P2PK witness).
  const witnesses = [0, ...mergeTokens.map(() => presenceWitnessIdx)];
  const newStates = [poolTokenOut, traderTokenOut];
  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: kasReserve * SCALE, scriptPublicKey: poolCpV3Spk(k, curRedeem), signatureScript: v3SwapBuySig(k, curRedeem, q.kasInUnits, q.tokenOut, poolTokenOut, traderTokenOut), redeem: curRedeem, role: 'pool' },
    { transactionId: utxo.tokenUtxo.transactionId, index: utxo.tokenUtxo.index, value: utxo.tokenUtxo.value, scriptPublicKey: kcc20Spk(k, poolTokInRedeem), signatureScript: transferSigScript(k, poolTokInRedeem, newStates, witnesses), redeem: poolTokInRedeem, role: 'poolToken' },
    ...mergeTokens.map((tt) => {
      const r = materializeKcc20Script(tokenTpl, tt.state);
      return { transactionId: tt.transactionId, index: tt.index, value: tt.value, scriptPublicKey: kcc20Spk(k, r), signatureScript: transferSigScript(k, r, newStates, witnesses), redeem: r, role: 'traderToken' as const };
    }),
  ];
  const outputs: CovOutput[] = [
    { value: q.newKas * SCALE, scriptPublicKey: poolCpV3Spk(k, newRedeem), role: 'pool', binding: { covid: poolCovidHex, authorizingInput: 0 } },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, poolTokenOut)), role: 'poolToken', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, traderTokenOut)), role: 'trader', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
    { value: q.creatorOut, scriptPublicKey: p2pkSpk(k, params.creatorFeeOwner), role: 'creatorFee' },
    { value: q.platformOut, scriptPublicKey: p2pkSpk(k, params.platformFeeOwner), role: 'platformFee' },
  ];
  return { kind: 'swapKasForToken', inputs, outputs, economics: { kasIn: q.kasIn, tokenOut: q.tokenOut }, covids: { poolCovid: poolCovidHex, tokenCovid: tokenCovidHex } };
}

/** swapTokenForKas (v3 — FRACTIONAL): fold `q.tokenIn` of the trader's piece(s) into the pool, getting kasOut;
 *  the UNSOLD remainder (Σ trader inputs − q.tokenIn) returns as ONE presence-owned change output (placed LAST).
 *  Outputs: [0]=pool [1]=pool token(P) [2]=creatorFee [3]=platformFee [4]=OPTIONAL trader change(presence). */
export function buildPoolV3SwapTokenForKas(
  k: K, tpl: PoolCpV3Template, tokenTpl: Kcc20Template, params: PoolV3Params,
  utxo: PoolCpV3Utxo, poolCovid: Uint8Array, traderPubkey: Uint8Array,
  traderTokens: { transactionId: string; index: number; value: bigint; state: Kcc20State }[],
  q: PoolCpSellQuote, presenceWitnessIdx: number, opts: { tokenDust?: bigint } = {},
): CovenantSpend {
  if (traderTokens.length < 1) throw new Error('need at least one trader token');
  const dust = opts.tokenDust ?? 1000n;
  const { kasReserve, tokenReserve, tokenCovid, totalShares, lpCovid } = utxo.state;
  const poolCovidHex = hexOf(poolCovid);
  const tokenCovidHex = hexOf(tokenCovid);
  const traderIn = traderTokens.reduce((s, t) => s + t.state.amount, 0n);
  const change = traderIn - q.tokenIn;   // q.tokenIn == the amount folded into the reserve
  if (change < 0n) throw new Error('trader inputs are less than the sell amount');
  const hasChange = change > 0n;
  const poolTokenOut = covenantIdOwned(poolCovid, q.newToken, false);
  const traderChangeOut = addressPresenceOwned(traderPubkey, hasChange ? change : 1n); // dummy(1) on a full sell — the covenant ignores it
  const curRedeem = materializePoolCpV3Script(tpl, utxo.state);
  const newRedeem = materializePoolCpV3Script(tpl, { kasReserve: q.newKas, tokenReserve: q.newToken, tokenCovid, totalShares, lpCovid });
  const poolTokInRedeem = materializeKcc20Script(tokenTpl, covenantIdOwned(poolCovid, tokenReserve, false));
  const witnesses = [0, ...traderTokens.map(() => presenceWitnessIdx)];
  // covid-A outputs in tx order: pool reserve first (idx 1), then the change LAST (idx 4) when present.
  const newStates = hasChange ? [poolTokenOut, traderChangeOut] : [poolTokenOut];
  const inputs: CovInput[] = [
    { transactionId: utxo.transactionId, index: utxo.index, value: kasReserve * SCALE, scriptPublicKey: poolCpV3Spk(k, curRedeem), signatureScript: v3SwapSellSig(k, curRedeem, q.kasOutUnits, poolTokenOut, traderChangeOut), redeem: curRedeem, role: 'pool' },
    { transactionId: utxo.tokenUtxo.transactionId, index: utxo.tokenUtxo.index, value: utxo.tokenUtxo.value, scriptPublicKey: kcc20Spk(k, poolTokInRedeem), signatureScript: transferSigScript(k, poolTokInRedeem, newStates, witnesses), redeem: poolTokInRedeem, role: 'poolToken' },
    ...traderTokens.map((tt) => {
      const r = materializeKcc20Script(tokenTpl, tt.state);
      return { transactionId: tt.transactionId, index: tt.index, value: tt.value, scriptPublicKey: kcc20Spk(k, r), signatureScript: transferSigScript(k, r, newStates, witnesses), redeem: r, role: 'traderToken' as const };
    }),
  ];
  const outputs: CovOutput[] = [
    { value: q.newKas * SCALE, scriptPublicKey: poolCpV3Spk(k, newRedeem), role: 'pool', binding: { covid: poolCovidHex, authorizingInput: 0 } },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, poolTokenOut)), role: 'poolToken', binding: { covid: tokenCovidHex, authorizingInput: 1 } },
    { value: q.creatorOut, scriptPublicKey: p2pkSpk(k, params.creatorFeeOwner), role: 'creatorFee' },
    { value: q.platformOut, scriptPublicKey: p2pkSpk(k, params.platformFeeOwner), role: 'platformFee' },
  ];
  if (hasChange) outputs.push({ value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, traderChangeOut)), role: 'trader', binding: { covid: tokenCovidHex, authorizingInput: 1 } });
  return { kind: 'swapTokenForKas', inputs, outputs, economics: { kasOut: q.kasOut, tokenIn: q.tokenIn }, covids: { poolCovid: poolCovidHex, tokenCovid: tokenCovidHex } };
}
