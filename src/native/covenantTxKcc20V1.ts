// kcc20v1 (KCC-20 standard) family — covenant-spend types, v1 transaction assembly, mass and the signature splice
// (docs/kcc20v1/PLAN.md §5 "Web and SDK", D21). Parallel to ./covenantTxV1.ts, which stays byte-frozen for the
// audited family. PURE: no RPC, wallet or network import, so the Node gates (verify:mass-v1) run the exact code the
// browser runs; ./spendV1.ts adds the wallet round-trip on top.
//
// What differs from the audited family: a holder's token input is authorized by a Schnorr signature INSIDE the
// token program's witness (KCC-20 owner scheme 0x00/0x01), not by a co-present P2PK input alone. So a family spend
// has three input classes — covenant inputs that need nothing (curve, pool, order, covenant-owned token pieces),
// holder token inputs whose witness carries a SIG65_PLACEHOLDER until the wallet signs, and plain P2PK funding
// inputs. `signFamilyTxV1` / `applyWalletSignaturesV1` fill the last two; the covenant inputs are never touched.
import type { Kaspa } from '../wasm/kaspa.types.js';
import { normalizedTransientMass, feeForMass } from './l1Fee.js';
import { hexOf, bytesOfHex } from './dispatchTag.js';

type K = Kaspa;
export type Spk = any;

export const TX_VERSION = 1;
export const SUBNET_ZERO = '0000000000000000000000000000000000000000';
export const MASS_CAP = 500_000n;
/** Per-input ComputeBudget (v1): compute_mass adds 100 grams per unit. A P2PK input is one sig op (budget 10). The
 *  family redeems are small (curve 14.6 KB, pool 13.5 KB, order 0.6 KB, token 4 KB) but a holder token input runs a
 *  Schnorr verify inside the program, so it gets more than the audited presence-owned token. Conservative headroom;
 *  verify:mass-v1 records what the shapes actually cost against the 500k cap. */
export const FUNDING_COMPUTE_V1 = 10;
export const CURVE_V1_COMPUTE = 400;
export const POOL_V1_COMPUTE = 400;
export const ORDER_V1_COMPUTE = 100;
export const TOKEN_V1_COMPUTE = 200;

/** A covenant UTXO being spent, with its signature script already assembled by a family builder. */
export type CovInputV1 = {
  transactionId: string; index: number; value: bigint;
  scriptPublicKey: Spk; redeem: Uint8Array;
  /** the covenant id this input carries (hex) */
  covid: string;
  role: string;
  computeBudget: number;
  /** the signature script (hex). When `sign` is set it carries a SIG65_PLACEHOLDER inside the witness. */
  signatureScript: string;
  /** the logical invocation, for the confirm step and the gates: program, entry, and the decoded arguments */
  invocation: { program: 'curve' | 'pool' | 'poolOpen' | 'order' | 'token'; entry: string; args: unknown[] };
  /** present on a holder's token input: who must sign and how the final script is rebuilt from the signature */
  sign?: { holderPubkey: Uint8Array; ownerScheme: number; withSignature: (sig65: Uint8Array) => string };
};
export type CovOutputV1 = { value: bigint; scriptPublicKey: Spk; role: string; covenant?: { covid: string; authorizingInput: number } };
export type CovenantSpendV1 = {
  family: 'kcc20v1';
  kind: 'init' | 'buy' | 'sell' | 'graduate' | 'batchBuy' | 'swapKasForToken' | 'swapTokenForKas' | 'addLiquidity' | 'removeLiquidity' | 'bindLp' | 'bindLpOpen' | 'closePool' | 'refundOrder' | 'transfer' | 'genesis' | 'poolGenesis';
  inputs: CovInputV1[];
  outputs: CovOutputV1[];
  economics: Record<string, bigint>;
  covids: Record<string, string>;
  /** true when the covenant pins tx.outputs.length (batchBuy): no change output may be appended */
  fixedOutputs?: boolean;
};

/** A funding UTXO (SDK UtxoEntryReference or a plain entry). */
export type FundingEntryV1 = { outpoint: { transactionId: string; index: number }; amount: bigint; scriptPublicKey: Spk; address?: string; blockDaaScore?: bigint; isCoinbase?: boolean } | any;
export type AssembledFamilyTx = {
  transaction: any;
  /** the P2PK funding inputs the wallet signs as ordinary inputs */
  fundingInputIndexes: number[];
  /** the holder token inputs whose witness needs the wallet's signature (sign-and-extract, D21) */
  tokenSignInputIndexes: number[];
  totalIn: bigint; covenantOut: bigint; change: bigint;
};

/** Assemble a complete v1 transaction: covenant inputs (pre-scripted), funding inputs (empty), covenant outputs
 *  with their CovenantBinding, plain outputs, and a change output unless the shape pins its output count. */
export function assembleFamilyTx(k: K, opts: { spend: CovenantSpendV1; fundingEntries: FundingEntryV1[]; changeAddress: string; networkFee: bigint; payload?: string; networkId?: string }): AssembledFamilyTx {
  const kk = k as any;
  const { spend, fundingEntries, changeAddress, networkFee, networkId } = opts;
  // D21 "labels": every input's utxo entry carries the address its script derives to — a covenant input the P2SH of its
  // redeem, a funding input the holder's P2PK address — so a wallet's approval screen names the UTXO it is asked to sign
  // (KCC-12 §6.7 requires the wallet to show the amount and the signing account per input) and KCC-12 `signInputs` entries
  // can carry the required `address`. Labels are display/addressing metadata: they are not part of the sighash or the
  // serialized transaction. Omitted when the caller passes no networkId (pure Node gates that never reach a wallet).
  const addressOf = (spk: Spk): string | undefined => { if (!networkId) return undefined; try { return String(kk.addressFromScriptPublicKey(spk, networkId).toString()); } catch { return undefined; } };
  const covInputs = spend.inputs.map((ci) => new kk.TransactionInput({
    previousOutpoint: { transactionId: ci.transactionId, index: ci.index },
    signatureScript: ci.signatureScript, sequence: 0n, sigOpCount: 0, computeBudget: ci.computeBudget,
    utxo: { outpoint: { transactionId: ci.transactionId, index: ci.index }, amount: ci.value, scriptPublicKey: ci.scriptPublicKey, blockDaaScore: 0n, isCoinbase: false, ...(addressOf(ci.scriptPublicKey) ? { address: addressOf(ci.scriptPublicKey) } : {}) },
  }));
  const fundingInputs = fundingEntries.map((e) => new kk.TransactionInput({ previousOutpoint: e.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 0, computeBudget: FUNDING_COMPUTE_V1, utxo: e?.address || !addressOf(e?.scriptPublicKey) ? e : { ...e, address: addressOf(e.scriptPublicKey) } }));
  const covInValue = spend.inputs.reduce((s, ci) => s + ci.value, 0n);
  const fundingTotal = fundingEntries.reduce((s: bigint, e: any) => s + BigInt(e.amount), 0n);
  const totalIn = covInValue + fundingTotal;
  const covenantOut = spend.outputs.reduce((s, o) => s + o.value, 0n);
  const change = totalIn - covenantOut - networkFee;
  if (change < 0n) throw new Error(`insufficient funding: need ${covenantOut + networkFee} sompi, have ${totalIn}`);
  const outputs = spend.outputs.map((o) => o.covenant
    ? new kk.TransactionOutput(o.value, o.scriptPublicKey, new kk.CovenantBinding(o.covenant.authorizingInput, new kk.Hash(o.covenant.covid)))
    : new kk.TransactionOutput(o.value, o.scriptPublicKey));
  if (spend.fixedOutputs) {
    if (change !== 0n) throw new Error(`${spend.kind} pins its output count: fund it exactly (${change} sompi would be left over)`);
  } else if (change > 0n) {
    outputs.push(new kk.TransactionOutput(change, kk.payToAddressScript(changeAddress)));
  }
  const transaction = new kk.Transaction({ version: TX_VERSION, inputs: [...covInputs, ...fundingInputs], outputs, lockTime: 0n, gas: 0n, payload: opts.payload ?? '', subnetworkId: SUBNET_ZERO });
  return {
    transaction,
    fundingInputIndexes: fundingInputs.map((_: unknown, i: number) => i + covInputs.length),
    tokenSignInputIndexes: spend.inputs.flatMap((ci, i) => (ci.sign ? [i] : [])),
    totalIn, covenantOut, change,
  };
}

// --- mass (ports of covenantTxV1's serializedSize / massDims; consensus mass::transaction_estimated_serialized_size) -
const hexBytes = (h: any): bigint => BigInt(Math.ceil(String(h ?? '').length / 2));
export function serializedSizeV1(tx: any): bigint {
  let size = 2n + 8n + 8n + 8n + 20n + 8n + 32n + 8n;
  size += hexBytes(tx.payload);
  for (const inp of tx.inputs ?? []) { size += 32n + 4n + 8n + 8n + hexBytes(inp.signatureScript) + 2n; }
  for (const out of tx.outputs ?? []) { size += 8n + 2n + 8n + hexBytes(out.scriptPublicKey?.script ?? out.scriptPublicKey); if (out.covenant) size += 2n + 32n; }
  return size;
}
/** The three mass dimensions with placeholder 66-byte signatures on the listed inputs — the FUNDING inputs only: a holder
 *  token input's signature script is already its final size before signing (the witness is spliced into a same-length slot),
 *  so listing it here under-measures by the whole redeem. storage = the SDK figure (0 when the SDK cannot compute it),
 *  compute = bytes + spk bytes×10 + budgets×100, transient = normalized size. */
export function massDimsV1(k: K, tx: any, networkId: string, placeholderIdxs: number[]): { compute: bigint; transient: bigint; storage: bigint; bytes: bigint } {
  const kk = k as any;
  const ins = tx.inputs; const saved = placeholderIdxs.map((i) => ins[i].signatureScript);
  for (const i of placeholderIdxs) ins[i].signatureScript = '00'.repeat(66);
  tx.inputs = ins;
  let storage = 0n; try { storage = BigInt(kk.calculateTransactionMass(networkId, tx)); } catch { storage = 0n; }
  let budgets = 0n; for (const inp of tx.inputs) budgets += BigInt(inp.computeBudget || 0) * 100n;
  let spkBytes = 0n; for (const out of tx.outputs ?? []) spkBytes += hexBytes(out.scriptPublicKey?.script ?? out.scriptPublicKey);
  const bytes = serializedSizeV1(tx);
  const ins2 = tx.inputs; placeholderIdxs.forEach((i, j) => (ins2[i].signatureScript = saved[j])); tx.inputs = ins2;
  return { compute: bytes + spkBytes * 10n + budgets, transient: normalizedTransientMass(bytes), storage, bytes };
}
export const withinCapsV1 = (d: { compute: bigint; transient: bigint; storage: bigint }): boolean => d.compute <= MASS_CAP && d.transient <= MASS_CAP && d.storage <= MASS_CAP;
/** Fee covering the largest normalized dimension (compute incl. budgets vs transient), like the audited family. */
export function feeForTxV1(k: K, tx: any, networkId: string, feeRate: number, placeholderIdxs: number[]): bigint {
  const d = massDimsV1(k, tx, networkId, placeholderIdxs);
  const billable = d.compute > d.transient ? d.compute : d.transient;
  return feeForMass(billable, feeRate);
}

// --- signatures: sign-and-extract (D21) -------------------------------------------------------------------------
/** Produces `sig64 ‖ 0x01` (65 bytes, SIGHASH_ALL) for input `index` of `tx`. The dev-key signer wraps the SDK; the
 *  wallet path extracts it from the signature script a wallet returns for that input. */
export type InputSignerV1 = (tx: any, index: number) => Promise<Uint8Array> | Uint8Array;
const P2PK_SIG_RE = /^41[0-9a-f]{130}$/i;
/** A wallet's P2PK-style signature script `41 ‖ sig64 ‖ 01` → the 65 signature bytes; refuses any other sighash. */
export function liftSignature65(sigScriptHex: string): Uint8Array {
  const s = String(sigScriptHex ?? '').replace(/^0x/, '').toLowerCase();
  if (!P2PK_SIG_RE.test(s) || !s.endsWith('01')) throw new Error(`wallet returned a signature without canonical SIGHASH_ALL (${s.length ? `${s.length / 2}-byte script ending 0x${s.slice(-2)}` : 'empty'})`);
  return bytesOfHex(s).slice(1);
}
export const p2pkSigScript = (sig65: Uint8Array): string => { if (sig65.length !== 65 || sig65[64] !== 0x01) throw new Error('signature must be 65 bytes ending in SIGHASH_ALL'); return `41${hexOf(sig65)}`; };
export function devKeySignerV1(k: K, privKey: any): InputSignerV1 {
  const kk = k as any;
  return (tx, index) => {
    const raw = bytesOfHex(String(kk.createInputSignature(tx, index, privKey, kk.SighashType.All)));
    const s = raw.length === 66 ? raw.slice(1) : raw;
    if (s.length !== 65 || s[64] !== 0x01) throw new Error(`unexpected signature shape (${raw.length} bytes)`);
    return s;
  };
}
/** Sign the funding inputs (ordinary P2PK scripts) and the holder token inputs (witness splice) in place. Signature
 *  scripts are not covered by the sighash, so every signature is computed over the transaction as assembled. */
export async function signFamilyTxV1(k: K, asm: AssembledFamilyTx, spend: CovenantSpendV1, signer: InputSignerV1): Promise<any> {
  const tx = asm.transaction;
  const sigs = new Map<number, Uint8Array>();
  for (const i of [...asm.fundingInputIndexes, ...asm.tokenSignInputIndexes]) sigs.set(i, await signer(tx, i));
  const inputs = tx.inputs;
  for (const i of asm.fundingInputIndexes) inputs[i].signatureScript = p2pkSigScript(sigs.get(i)!);
  for (const i of asm.tokenSignInputIndexes) inputs[i].signatureScript = spend.inputs[i].sign!.withSignature(sigs.get(i)!);
  tx.inputs = inputs;
  assertInvocationsV1(tx, spend);
  return tx;
}
/** The wallet round-trip's local side: take the signature scripts a wallet returned for the requested inputs, lift the
 *  65 signature bytes of each holder token input and splice them into the covenant witness, keep the funding inputs'
 *  scripts, and leave every other field as THIS side assembled it. */
export function applyWalletSignaturesV1(k: K, asm: AssembledFamilyTx, spend: CovenantSpendV1, signedInputs: { index: number; signatureScript?: string; signature?: string }[]): any {
  const kk = k as any;
  const tx = kk.Transaction.deserializeFromSafeJSON(asm.transaction.serializeToSafeJSON());
  const byIndex = new Map(signedInputs.map((s) => [s.index, s]));
  const sig65Of = (i: number): Uint8Array => {
    const s = byIndex.get(i);
    if (!s) throw new Error(`wallet did not sign input ${i}`);
    if (s.signature != null) {
      // KCC-12 §6.7 returns the RAW 64-byte signature (no sighash byte); the requested type was SIGHASH_ALL, so the dApp
      // appends 0x01 itself. A 65-byte value (a wallet that mirrors createInputSignature) must already end in 0x01.
      const b = bytesOfHex(String(s.signature).replace(/^0x/, ''));
      if (b.length === 64) return Uint8Array.from([...b, 0x01]);
      if (b.length !== 65 || b[64] !== 0x01) throw new Error(`input ${i}: signature is not 64 raw bytes or 65 bytes ending in SIGHASH_ALL (${b.length} bytes)`);
      return b;
    }
    return liftSignature65(s.signatureScript ?? '');
  };
  const inputs = tx.inputs;
  for (const i of asm.fundingInputIndexes) inputs[i].signatureScript = p2pkSigScript(sig65Of(i));
  for (const i of asm.tokenSignInputIndexes) inputs[i].signatureScript = spend.inputs[i].sign!.withSignature(sig65Of(i));
  tx.inputs = inputs;
  assertInvocationsV1(tx, spend);
  return tx;
}

// --- structural check: every covenant input's final script is a well-formed KCC-1 invocation --------------------
/** Parse data pushes (KCC-1 §3.4.2); throws on a non-push opcode or truncation. */
export function parsePushesV1(bytes: Uint8Array): { payload: Uint8Array; raw: Uint8Array }[] {
  const out: { payload: Uint8Array; raw: Uint8Array }[] = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i]; let len = 0, hdr = 1, payload: Uint8Array | null = null;
    if (op === 0x00) payload = new Uint8Array(0);
    else if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === 0x4c) { len = bytes[i + 1]; hdr = 2; }
    else if (op === 0x4d) { len = bytes[i + 1] | (bytes[i + 2] << 8); hdr = 3; }
    else if (op === 0x4e) { len = (bytes[i + 1] | (bytes[i + 2] << 8) | (bytes[i + 3] << 16) | (bytes[i + 4] << 24)) >>> 0; hdr = 5; }
    else if (op === 0x4f) payload = Uint8Array.of(0x81);
    else if (op >= 0x51 && op <= 0x60) payload = Uint8Array.of(op - 0x50);
    else throw new Error(`non-push opcode 0x${op.toString(16)} at ${i}`);
    if (payload === null) { if (i + hdr + len > bytes.length) throw new Error('truncated data push'); payload = bytes.slice(i + hdr, i + hdr + len); }
    out.push({ payload, raw: bytes.slice(i, i + hdr + len) });
    i += hdr + len;
  }
  return out;
}
/** KCC-1 PushMinimal of a payload — to check a push is canonical. */
export function pushMinimalV1(p: Uint8Array): Uint8Array {
  const n = p.length;
  if (n === 0) return Uint8Array.of(0x00);
  if (n === 1 && p[0] >= 1 && p[0] <= 16) return Uint8Array.of(0x50 + p[0]);
  if (n === 1 && p[0] === 0x81) return Uint8Array.of(0x4f);
  if (n <= 75) return Uint8Array.from([n, ...p]);
  if (n <= 255) return Uint8Array.from([0x4c, n, ...p]);
  if (n <= 65535) return Uint8Array.from([0x4d, n & 0xff, n >> 8, ...p]);
  return Uint8Array.from([0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff, ...p]);
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
/** Every covenant input: push-only, every push PushMinimal, a 4-byte tag second-to-last, the input's redeem last,
 *  and no SIG65_PLACEHOLDER left behind on an input that needed a signature. */
export function assertInvocationsV1(tx: any, spend: CovenantSpendV1): void {
  for (const [i, ci] of spend.inputs.entries()) {
    const script = String(tx.inputs[i].signatureScript ?? '');
    const pushes = parsePushesV1(bytesOfHex(script));
    if (pushes.length < 2) throw new Error(`input ${i} (${ci.role}): invocation needs a tag and a redeem push`);
    for (const [j, p] of pushes.entries()) if (!same(p.raw, pushMinimalV1(p.payload))) throw new Error(`input ${i} (${ci.role}): push ${j} is not PushMinimal`);
    if (pushes[pushes.length - 2].payload.length !== 4) throw new Error(`input ${i} (${ci.role}): dispatch tag push is not 4 bytes`);
    if (!same(pushes[pushes.length - 1].payload, ci.redeem)) throw new Error(`input ${i} (${ci.role}): the last push is not this input's redeem script`);
    if (ci.sign && script.includes('00'.repeat(65))) throw new Error(`input ${i} (${ci.role}): holder signature placeholder is still present`);
  }
}

/** What the confirm step shows: each covenant input with its program, entry and covenant id, and for every token
 *  leader the successor states it declares (the `next_states` a holder is asked to authorize). */
export function describeSpendV1(spend: CovenantSpendV1): { inputs: { index: number; role: string; program: string; entry: string; covid: string; signs: boolean }[]; nextStates: { inputIndex: number; states: unknown[] }[] } {
  return {
    inputs: spend.inputs.map((ci, index) => ({ index, role: ci.role, program: ci.invocation.program, entry: ci.invocation.entry, covid: ci.covid, signs: !!ci.sign })),
    nextStates: spend.inputs.flatMap((ci, inputIndex) => (ci.invocation.program === 'token' && ci.invocation.entry === 'transfer' ? [{ inputIndex, states: ci.invocation.args[0] as unknown[] }] : [])),
  };
}
