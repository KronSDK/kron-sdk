// Native covenant-spend assembly — shared types + the tx-assembly layer for the native (KCC-20) builders.
// A native action (init/buy/sell/graduate/swap) yields a `CovenantSpend`: the covenant INPUTS it spends
// (each pre-scripted — the covenant's own transition rules authorize the spend, so no key signature) and
// the covenant-required OUTPUTS (continuation, minted/moved token balances, fee). This module bolts on the
// trader's funding inputs + change to make a complete Kaspa transaction.
//
// Production signing path: the app builds the tx here, the wallet signs only the trader's P2PK funding
// inputs via its signPskt-equivalent bridge (see ../wallet/types.ts), and the app broadcasts — covenant
// inputs never need a wallet signature. `toPsktJson` shapes the tx + the funding-input indices for that
// bridge.
//
// No top-level SDK import (only `import type`) — caller passes the loaded WASM namespace `k`.
import type { Kaspa } from '../wasm/kaspa.types.js';

type K = Kaspa;
type Spk = any;

/** A covenant UTXO being spent, already carrying its signature script (no wallet signature needed). */
export type CovInput = {
  transactionId: string;
  index: number;
  value: bigint;
  scriptPublicKey: Spk;
  /** the covenant signature script (hex): <args> [selector] <redeem>, or kcc20 <transfer args> <redeem>. */
  signatureScript: string;
  /** redeem script bytes (kept so a caller can re-derive / inspect the spend). */
  redeem: Uint8Array;
  /** what this input is, for assembly/debugging: 'curve' | 'minterBranch' | 'burn' | 'pool' | 'poolToken'. */
  role: string;
};

/** A covenant-required output (value + scriptPublicKey). */
export type CovOutput = { value: bigint; scriptPublicKey: Spk; role: string };

/** A complete covenant action: the inputs it spends + the outputs it must create + computed economics. */
export type CovenantSpend = {
  kind: 'init' | 'initVested' | 'buy' | 'sell' | 'graduate' | 'swapKasForToken' | 'swapTokenForKas' | 'addLiquidity' | 'removeLiquidity' | 'bindLp' | 'claim' | 'claimFinal';
  inputs: CovInput[];
  outputs: CovOutput[];
  economics: Record<string, bigint>;
  /** covenant-ids this action establishes/uses (hex): the bound token `A`, a new pool `P`, the curve `C`. */
  covids?: { tokenCovid?: string; poolCovid?: string; curveCovid?: string };
};

/** A funding UTXO entry (SDK UtxoEntryReference from rpc.getUtxosByAddresses, or a plain IUtxoEntry). */
export type FundingEntry = any;

const SUBNET_ZERO = '0000000000000000000000000000000000000000';

export type AssembledNativeTx = {
  transaction: any;
  /** indices of inputs the trader/wallet must sign (the covenant inputs come first and are pre-scripted). */
  fundingInputIndexes: number[];
  totalIn: bigint;
  covenantOut: bigint;
  change: bigint;
};

/**
 * Assemble a complete tx: the spend's covenant inputs (pre-scripted) + the trader's funding inputs + a
 * change output. `networkFee` is caller-provided (derive from the node; KIP-9 storage mass depends on
 * output values, so the node confirms the exact fee/change at broadcast). Covenant inputs carry sigOpCount
 * 0 (no checkSig on the accept path used here); funding inputs are signed via signFundingInputs.
 */
export function assembleNativeTx(
  k: K,
  opts: { spend: CovenantSpend; fundingEntries: FundingEntry[]; changeAddress: string; networkFee: bigint },
): AssembledNativeTx {
  const { spend, fundingEntries, changeAddress, networkFee } = opts;
  const kk = k as any;

  const covInputs = spend.inputs.map(
    (ci) =>
      new kk.TransactionInput({
        previousOutpoint: { transactionId: ci.transactionId, index: ci.index },
        signatureScript: ci.signatureScript,
        sequence: 0n,
        sigOpCount: 0,
        utxo: {
          outpoint: { transactionId: ci.transactionId, index: ci.index },
          amount: ci.value,
          scriptPublicKey: ci.scriptPublicKey,
          blockDaaScore: 0n,
          isCoinbase: false,
        },
      }),
  );
  const fundingInputs = fundingEntries.map(
    (e) => new kk.TransactionInput({ previousOutpoint: e.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1, utxo: e }),
  );

  const covInValue = spend.inputs.reduce((s, ci) => s + ci.value, 0n);
  const fundingTotal = fundingEntries.reduce((s, e) => s + BigInt(e.amount), 0n);
  const totalIn = covInValue + fundingTotal;
  const covenantOut = spend.outputs.reduce((s, o) => s + o.value, 0n);
  const change = totalIn - covenantOut - networkFee;
  if (change < 0n) throw new Error(`insufficient funding: need ${covenantOut + networkFee} sompi, have ${totalIn}`);

  const outputs = spend.outputs.map((o) => new kk.TransactionOutput(o.value, o.scriptPublicKey));
  outputs.push(new kk.TransactionOutput(change, kk.payToAddressScript(changeAddress)));

  const transaction = new kk.Transaction({
    version: 0,
    inputs: [...covInputs, ...fundingInputs],
    outputs,
    lockTime: 0n,
    gas: 0n,
    payload: '',
    subnetworkId: SUBNET_ZERO,
  });
  return {
    transaction,
    fundingInputIndexes: fundingInputs.map((_, i) => i + covInputs.length),
    totalIn,
    covenantOut,
    change,
  };
}

/** Sign the trader's funding inputs (P2PK) in place; covenant inputs are left untouched (pre-scripted). */
export function signFundingInputs(k: K, tx: any, privKey: any, fundingInputIndexes: number[]): any {
  const inputs = tx.inputs;
  for (const idx of fundingInputIndexes) {
    const sig = (k as any).createInputSignature(tx, idx, privKey);
    inputs[idx].signatureScript = new (k as any).ScriptBuilder().addData(sig).drain();
  }
  tx.inputs = inputs;
  return tx;
}

/**
 * Shape the assembled tx for a signPskt-style wallet bridge. Returns the tx JSON the wallet deserializes
 * plus the inputs it should sign (the trader's P2PK funding inputs only).
 */
export function toPsktJson(asm: AssembledNativeTx, sighashType = 1): { txJsonString: string; signInputs: { index: number; sighashType: number }[] } {
  return {
    txJsonString: asm.transaction.serializeToSafeJSON(),
    signInputs: asm.fundingInputIndexes.map((index) => ({ index, sighashType })),
  };
}

/**
 * The local side of a signPskt-style wallet bridge: deserialize a tx (Safe JSON), sign ONLY the listed
 * inputs with `privKey` (the user's P2PK inputs — funding, or the co-present presence input that authorizes
 * a sell/transfer of an address-owned token), reserialize to Safe JSON. Covenant inputs (not listed) are
 * left untouched: their transition rules — or the presence-based ownership check against a co-present
 * signed P2PK input — authorize them, so the wallet never signs a covenant P2SH input directly. This is
 * exactly what an extension wallet's native `signPskt({ txJsonString, options: { signInputs } })` does; use
 * this function to emulate that bridge with a raw key (e.g. for a backend bot holding its own key).
 */
export function signPsktWithKey(k: K, txJsonString: string, signInputs: { index: number }[], privKey: any): string {
  const kk = k as any;
  const tx = kk.Transaction.deserializeFromSafeJSON(txJsonString);
  const inputs = tx.inputs;
  for (const { index } of signInputs) {
    const sig = kk.createInputSignature(tx, index, privKey);
    inputs[index].signatureScript = new kk.ScriptBuilder().addData(sig).drain();
  }
  tx.inputs = inputs;
  return tx.serializeToSafeJSON();
}
