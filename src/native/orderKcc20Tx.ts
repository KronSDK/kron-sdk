// kcc20v1 (KCC-20 standard) family — buy-order builders (covenants/kcc20v1/order_kcc20.sil). Twin of ./buyOrderTx.ts
// (frozen). The order's state carries the token covenant id (PLAN §4 rule 6): span {1,117} = [20 curve] [20 buyer]
// [20 token] [08 kasIn] [08 minTokenOut]. `settle` runs with the order at input 2 or 3 of a batchBuy and validates the
// buyer's output at token output slot+1; `refund` is one order at input 0 repaid in full at output 0.
import type { Kaspa } from '../wasm/kaspa.types.js';
import { SigScriptBuilder } from './sigscript.js';
import { FEE_OUT_MIN } from '../curve/cpCurve.js';
import { genesisCovenantId } from './genesis.js';
import { assertFamilyTagsV1, hexOf } from './dispatchTag.js';
import type { CompiledV1 } from './templatesV1.js';
import { type Kcc20V1State, type Kcc20V1Template, int8SM, pushExplicit, concat, pushTokenStateV1 } from './kcc20V1Tx.js';
import type { CovenantSpendV1 } from './covenantTxKcc20V1.js';
import { ORDER_V1_COMPUTE } from './covenantTxKcc20V1.js';

type K = Kaspa;
type Spk = any;
export const ORDER_V1_STATE_LEN = 117;
export const MIN_ORDER_KAS = 50_000_000n;
export const ORDER_TOKEN_DUST = 50_000_000n;
export const ORDER_TX_FEE = 20_000_000n;
const SCALE = 1_000_000n;
const padFee = (f: bigint) => (f > FEE_OUT_MIN ? f : FEE_OUT_MIN);

export type OrderV1Template = { prefix: Uint8Array; suffix: Uint8Array; templateHash: Uint8Array; tags: Record<string, Uint8Array>; token: Kcc20V1Template };
export type OrderV1State = { curveCovid: Uint8Array; buyerIdentifier: Uint8Array; tokenCovid: Uint8Array; kasIn: bigint; minTokenOut: bigint };
export type OrderV1Utxo = { transactionId: string; index: number; value: bigint; covid: string; state: OrderV1State };

export function orderTemplateFromCompiledV1(c: CompiledV1, token: Kcc20V1Template): OrderV1Template {
  const tags = assertFamilyTagsV1('order', c.dispatchTags);
  if (c.stateSpan.offset !== 1 || c.stateSpan.len !== ORDER_V1_STATE_LEN) throw new Error(`order state span {${c.stateSpan.offset},${c.stateSpan.len}} is not {1,117}`);
  if (!c.bytecodeHex.includes(hexOf(token.templateHash))) throw new Error('this order template was not compiled against the given token template');
  return { prefix: c.prefix, suffix: c.suffix, templateHash: Uint8Array.from((c.templateHash.match(/../g) ?? []).map((b) => parseInt(b, 16))), tags, token };
}
export function encodeOrderV1State(s: OrderV1State): Uint8Array {
  if (s.curveCovid.length !== 32 || s.buyerIdentifier.length !== 32 || s.tokenCovid.length !== 32) throw new Error('order identifiers must be 32 bytes');
  if (!s.curveCovid.some(Boolean) || !s.buyerIdentifier.some(Boolean) || !s.tokenCovid.some(Boolean)) throw new Error('order identifiers must not be zero');
  if (s.kasIn < MIN_ORDER_KAS || s.kasIn % SCALE !== 0n || s.minTokenOut <= 0n || s.minTokenOut > 1_000_000_000n) throw new Error('invalid order amount or minimum');
  return concat([pushExplicit(s.curveCovid), pushExplicit(s.buyerIdentifier), pushExplicit(s.tokenCovid), pushExplicit(int8SM(s.kasIn)), pushExplicit(int8SM(s.minTokenOut))]);
}
export const materializeOrderV1Script = (tpl: OrderV1Template, s: OrderV1State): Uint8Array => concat([tpl.prefix, encodeOrderV1State(s), tpl.suffix]);
export const orderV1Spk = (k: K, redeem: Uint8Array): Spk => (k as any).payToScriptHashScript(redeem);
const p2pkSpk = (k: K, pubkey: Uint8Array): Spk => { const sb = new (k as any).ScriptBuilder(); sb.addData(pubkey).addOp(172); return new (k as any).ScriptPublicKey(0, sb.drain()); };

/** The three fee legs an order pre-funds, each floored at FEE_OUT_MIN exactly as curve_kcc20.batchBuy computes them. */
export const orderFeesV1 = (kasIn: bigint, p: { creatorFeeBps: bigint; platformFeeBps: bigint; devFundBps: bigint }) =>
  ({ creator: padFee((kasIn * p.creatorFeeBps) / 10000n), platform: padFee((kasIn * p.platformFeeBps) / 10000n), devFund: padFee((kasIn * p.devFundBps) / 10000n) });
/** The exact escrow the covenant demands of an order input: kasIn + token dust + three fee legs + the tx fee share. */
export const orderEscrowV1 = (kasIn: bigint, p: { creatorFeeBps: bigint; platformFeeBps: bigint; devFundBps: bigint }): bigint => {
  const f = orderFeesV1(kasIn, p); return kasIn + ORDER_TOKEN_DUST + f.creator + f.platform + f.devFund + ORDER_TX_FEE;
};

export function orderSettleSigV1(k: K, tpl: OrderV1Template, redeem: Uint8Array, buyerOut: Kcc20V1State): string {
  const b = new SigScriptBuilder(k); pushTokenStateV1(b, tpl.token.templateHash, buyerOut); return b.data(tpl.tags.settle).redeem(redeem).drain();
}
const refundSig = (k: K, tpl: OrderV1Template, redeem: Uint8Array, buyerWitness: number): string => new SigScriptBuilder(k).int(BigInt(buyerWitness)).data(tpl.tags.refund).redeem(redeem).drain();

/** The order UTXO a buyer funds: its genesis covenant id, address and exact escrow value. */
export function buildOrderV1Genesis(k: K, tpl: OrderV1Template, state: OrderV1State, fundingOutpoint: { transactionId: string; index: number }, fees: { creatorFeeBps: bigint; platformFeeBps: bigint; devFundBps: bigint }, network: string, outIndex = 0) {
  const redeem = materializeOrderV1Script(tpl, state), scriptPublicKey = orderV1Spk(k, redeem), value = orderEscrowV1(state.kasIn, fees);
  const orderCovid = genesisCovenantId(k, fundingOutpoint, [{ index: outIndex, value, scriptPublicKey }]);
  return { orderCovid, orderAddress: (k as any).addressFromScriptPublicKey(scriptPublicKey, network)?.toString() ?? '', orderOutput: { value, scriptPublicKey }, redeem };
}
/** Cancel: one order at input 0, the buyer's P2PK input at `buyerWitness` (1), the full escrow back to the buyer at output 0. */
export function buildOrderV1Refund(k: K, tpl: OrderV1Template, order: OrderV1Utxo, buyerWitness = 1): CovenantSpendV1 {
  const redeem = materializeOrderV1Script(tpl, order.state);
  return {
    family: 'kcc20v1', kind: 'refundOrder',
    inputs: [{ transactionId: order.transactionId, index: order.index, value: order.value, scriptPublicKey: orderV1Spk(k, redeem), redeem, covid: order.covid, role: 'order', computeBudget: ORDER_V1_COMPUTE, signatureScript: refundSig(k, tpl, redeem, buyerWitness), invocation: { program: 'order', entry: 'refund', args: [BigInt(buyerWitness)] } }],
    outputs: [{ value: order.value, scriptPublicKey: p2pkSpk(k, order.state.buyerIdentifier), role: 'refund' }],
    economics: { refund: order.value }, covids: { orderCovid: order.covid },
  };
}
