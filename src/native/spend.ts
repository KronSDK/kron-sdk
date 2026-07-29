// Native covenant-spend assembly — shared types + the tx-assembly layer for the native (KCC-20) builders.
// A native action (init/buy/sell/graduate/swap) yields a `CovenantSpend`: the covenant INPUTS it spends
// (each pre-scripted — the covenant's own transition rules authorize the spend, so no key signature) and
// the covenant-required OUTPUTS (continuation, minted/moved token balances, fee). This module bolts on the
// trader's funding inputs + change to make a complete Kaspa transaction.
//
// Covenant transactions are Toccata/KIP-20 **version-1** transactions:
//   • covenant outputs must carry a `CovenantBinding(authorizingInput, covenantId)` — without it the output
//     never enters the covenant-id group, so in-covenant checks like `OpCovOutputCount(id)` see 0 outputs
//     and the spend fails on-chain with "script ran, but verification failed" (a v0 output CANNOT carry a
//     binding, so a v0 tx can never satisfy a covenant that validates its outputs);
//   • each input carries a `computeBudget` (v1 replaces sigOpCount as the execution-metering commitment) —
//     a P2PK funding input needs ~10, a kcc20 transfer input ~500, a curve/pool input ~2000.
// Set `binding` on each covenant `CovOutput` (the kcc20 builders do this when given the token covenant id);
// `assembleNativeTx` attaches the WASM `CovenantBinding` and role-based compute budgets.
//
// Production signing path: the app builds the tx here, the wallet signs only the trader's P2PK funding
// inputs via its signPskt-equivalent bridge (see ../wallet/types.ts), and the app broadcasts — covenant
// inputs never need a wallet signature. `toPsktJson` shapes the tx + the funding-input indices for that
// bridge. (The sighash commits to output covenant bindings, so bindings must be attached BEFORE signing.)
//
// No top-level SDK import (only `import type`) — caller passes the loaded WASM namespace `k`.
import type { Kaspa } from '../wasm/kaspa.types.js';
import { encodePartnerTag } from './partnerTag.js';

type K = Kaspa;
type Spk = any;

/** Covenant txs are KIP-20 v1 transactions (covenant outputs require tx.version >= 1). */
export const TX_VERSION = 1;
// Per-input compute budgets (v1). `computeBudget` is a CONSENSUS-SERIALIZED field and each unit costs 100
// grams of compute mass, which is capped at 500_000 and CANNOT be raised (params.rs `with_shared_limit`).
// KRON's redeem scripts are revealed in signatureScript and also count toward compute via tx_bytes, so
// oversized budgets pushed every curve tx past the cap (launch 561k / sell 667k). These are right-sized to
// match KRON's production values in `web/src/native/covenantTxV1.ts` — they MUST stay in step with it.
/** A P2PK funding input ≈ one sig op. */
export const FUNDING_COMPUTE = 10;
/** A kcc20 `transfer` input (~2.2KB redeem: token balance / inventory / seller piece); ≥20× over exec need. */
export const TOKEN_COMPUTE = 100;
/** A curve_cp / amm_pool_cp_v3 input (~150KB plain / ~217KB vested redeem); conservative headroom. */
export const COVENANT_COMPUTE = 400;
/** Covenant output min value (KIP-9 storage mass) — the conventional token-UTXO dust, 0.5 KAS. */
export const COVENANT_DUST = 50_000_000n;

// --- Toccata 3-D mass -----------------------------------------------------------------------------
// Mass is {storage, compute, transient}; the node compares each dimension's NORMALIZED mass
// (`ceil(raw × cofactor)`, cofactor_i = compute_limit / limit_i) and requires
// fee >= normalized_mass × min-relay-feerate. Mainnet post-Toccata: compute 500k, transient 1_000_000, so
//   cofactor_transient = 0.5  ⇒  normalized_transient = size × 4 × 0.5 = size × 2
// The vendored kaspa-wasm predates this model and exposes NO transient call, so transient is computed here.
export const MIN_RELAY_FEERATE = 100;                  // sompi per gram
const TRANSIENT_BYTE_TO_MASS_FACTOR = 4n;              // consensus/core/src/constants.rs
const COMPUTE_MASS_LIMIT = 500_000n;
const TRANSIENT_MASS_LIMIT = 1_000_000n;               // params.rs `new_transient_mass_limit`

/** Consensus-estimated serialized size, mirroring rusty-kaspa `transaction_estimated_serialized_size`
 *  (consensus/core/src/mass/mod.rs). Hex fields are 2 chars/byte. KRON's covenant redeems ride in
 *  signatureScript, so a curve trade serializes to ~175 KB regardless of trade size — which is exactly why
 *  transient, not compute, is the binding fee dimension. */
export function estimatedSerializedSize(tx: any): bigint {
  const hexBytes = (h: any): bigint => BigInt(Math.ceil(String(h ?? '').length / 2));
  let size = 2n + 8n + 8n + 8n + 20n + 8n + 32n + 8n; // version, #in, #out, locktime, subnetworkId, gas, payload hash, payload len
  size += hexBytes(tx.payload);
  for (const inp of tx.inputs ?? []) {
    size += 32n + 4n + 8n + 8n;                        // outpoint(txid+index), sigScript len, sequence
    size += hexBytes(inp.signatureScript);
    if (TX_VERSION >= 1) size += 2n;                   // compute_budget (u16)
  }
  for (const out of tx.outputs ?? []) {
    size += 8n + 2n + 8n;                              // value, spk version, spk len
    size += hexBytes(out.scriptPublicKey?.script ?? out.scriptPublicKey);
    if (out.covenant) size += 2n + 32n;                // authorizing_input (u16) + covenant_id
  }
  return size;
}

/** A covenant output's KIP-20 lineage: which covenant id it continues and which input authorizes it. */
export type CovBinding = { covid: string; authorizingInput: number };

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
  /** v1 compute budget override; defaults by role (curve/pool → COVENANT_COMPUTE, else TOKEN_COMPUTE). */
  computeBudget?: number;
};

/** A covenant-required output (value + scriptPublicKey [+ covenant binding]). */
export type CovOutput = { value: bigint; scriptPublicKey: Spk; role: string; binding?: CovBinding };

/** A complete covenant action: the inputs it spends + the outputs it must create + computed economics. */
export type CovenantSpend = {
  kind: 'init' | 'initVested' | 'buy' | 'sell' | 'transfer' | 'graduate' | 'swapKasForToken' | 'swapTokenForKas' | 'addLiquidity' | 'removeLiquidity' | 'bindLp' | 'claim' | 'claimFinal';
  inputs: CovInput[];
  outputs: CovOutput[];
  economics: Record<string, bigint>;
  /** covenant-ids this action establishes/uses (hex): the bound token `A`, a new pool `P`, the curve `C`. */
  covids?: { tokenCovid?: string; poolCovid?: string; curveCovid?: string };
};

/** A funding UTXO entry (SDK UtxoEntryReference from rpc.getUtxosByAddresses, or a plain IUtxoEntry). */
export type FundingEntry = any;

const SUBNET_ZERO = '0000000000000000000000000000000000000000';

const budgetForRole = (role: string): number => (role === 'curve' || role === 'pool' ? COVENANT_COMPUTE : TOKEN_COMPUTE);

export type AssembledNativeTx = {
  transaction: any;
  /** indices of inputs the trader/wallet must sign (the covenant inputs come first and are pre-scripted). */
  fundingInputIndexes: number[];
  totalIn: bigint;
  covenantOut: bigint;
  change: bigint;
};

/**
 * Assemble a complete v1 covenant tx: the spend's covenant inputs (pre-scripted) + the trader's funding
 * inputs + a change output. Covenant outputs whose `binding` is set carry the KIP-20 `CovenantBinding`
 * (REQUIRED for any output the covenant validates — see the module header). `networkFee` is
 * caller-provided; size it with `estimateNativeFee` (v1 fees must cover the per-input compute budget, so a
 * flat legacy fee is usually too low). Covenant inputs default to a role-based compute budget; funding
 * inputs are signed via signFundingInputs (or the signPskt bridge).
 */
export function assembleNativeTx(
  k: K,
  opts: { spend: CovenantSpend; fundingEntries: FundingEntry[]; changeAddress: string; networkFee: bigint; ref?: string },
): AssembledNativeTx {
  const { spend, fundingEntries, changeAddress, networkFee, ref } = opts;
  const kk = k as any;

  const covInputs = spend.inputs.map(
    (ci) =>
      new kk.TransactionInput({
        previousOutpoint: { transactionId: ci.transactionId, index: ci.index },
        signatureScript: ci.signatureScript,
        sequence: 0n,
        sigOpCount: 0,
        computeBudget: ci.computeBudget ?? budgetForRole(ci.role),
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
    (e) => new kk.TransactionInput({ previousOutpoint: e.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 0, computeBudget: FUNDING_COMPUTE, utxo: e }),
  );

  const covInValue = spend.inputs.reduce((s, ci) => s + ci.value, 0n);
  const fundingTotal = fundingEntries.reduce((s, e) => s + BigInt(e.amount), 0n);
  const totalIn = covInValue + fundingTotal;
  const covenantOut = spend.outputs.reduce((s, o) => s + o.value, 0n);
  const change = totalIn - covenantOut - networkFee;
  if (change < 0n) throw new Error(`insufficient funding: need ${covenantOut + networkFee} sompi, have ${totalIn}`);

  const outputs = spend.outputs.map((o) =>
    o.binding
      ? new kk.TransactionOutput(o.value, o.scriptPublicKey, new kk.CovenantBinding(o.binding.authorizingInput, new kk.Hash(o.binding.covid)))
      : new kk.TransactionOutput(o.value, o.scriptPublicKey),
  );
  outputs.push(new kk.TransactionOutput(change, kk.payToAddressScript(changeAddress)));

  const transaction = new kk.Transaction({
    version: TX_VERSION,
    inputs: [...covInputs, ...fundingInputs],
    outputs,
    lockTime: 0n,
    gas: 0n,
    // Partner attribution rides HERE, in the transaction itself — so it is captured whether the trade goes to
    // the sequencer or straight to a node. Recording it at relay time (the old design) meant a wallet with no
    // contention to sequence submitted direct and earned nothing. Empty string when untagged.
    payload: encodePartnerTag(ref),
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

/**
 * Size `networkFee` for an assembled v1 tx: byte/storage mass (via the WASM mass calculator, with
 * placeholder signatures on the funding inputs so byte mass is realistic) + the per-input compute budget
 * the calculator omits (grams = budget × 100), at `feeRateSompiPerGram` (use the node's feerate estimate;
 * min-relay on TN10 has been ~100 sompi/gram), with a 1.5× over-cover and a 10_000-sompi floor. Assemble
 * with a guess (e.g. 10_000n), call this, then re-assemble with the returned fee.
 */
export function estimateNativeFee(k: K, networkId: string, asm: AssembledNativeTx, feeRateSompiPerGram: number): bigint {
  const kk = k as any;
  const tx = asm.transaction;
  const ins = tx.inputs;
  const saved = asm.fundingInputIndexes.map((i: number) => ins[i].signatureScript);
  for (const i of asm.fundingInputIndexes) ins[i].signatureScript = '00'.repeat(66); // placeholder sig → realistic byte mass
  tx.inputs = ins;
  let byteMass = 2000n;
  try { byteMass = BigInt(kk.calculateTransactionMass(networkId, tx)); } catch { /* fall back */ }
  const ins2 = tx.inputs;
  asm.fundingInputIndexes.forEach((i: number, j: number) => (ins2[i].signatureScript = saved[j]));
  tx.inputs = ins2;
  let computeGrams = 0n;
  for (const inp of tx.inputs) computeGrams += BigInt(inp.computeBudget || 0) * 100n;
  const rawTransient = estimatedSerializedSize(tx) * TRANSIENT_BYTE_TO_MASS_FACTOR;
  const normTransient = (rawTransient * COMPUTE_MASS_LIMIT + TRANSIENT_MASS_LIMIT - 1n) / TRANSIENT_MASS_LIMIT;
  const compute = byteMass + computeGrams;
  const billable = compute > normTransient ? compute : normTransient;
  // The network's minimum relay feerate is 100 sompi/gram; a lower rate can never produce a relayable tx.
  const rate = BigInt(Math.max(Math.ceil(feeRateSompiPerGram), MIN_RELAY_FEERATE));
  const fee = (billable * rate * 6n) / 5n; // 1.2× over an exactly-mirrored mass
  return fee > 10000n ? fee : 10000n;
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
