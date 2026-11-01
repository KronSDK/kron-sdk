// kcc20v1 (KCC-20 standard) family — the wallet signing path (docs/kcc20v1/PLAN.md D21; KCC-12 §6.6/§6.7). The browser
// layer over ./covenantTxKcc20V1.ts: a family spend is assembled there; here the wallet is asked to sign the trader's P2PK
// funding inputs AND the trader's own token inputs, whose authorization is a Schnorr signature INSIDE the token program's
// witness. The D21 ORDER, enforced below and pinned by verify:kcc20v1-sighash:
//   (1) the request: token inputs listed with an EMPTY signature script, every input's `utxo.address` = the address its
//       script derives to (the token input's P2SH — the UTXO label a wallet shows), `sighashType: 1`, and (KCC-12 §6.7) each
//       entry's `address` = the SIGNING ACCOUNT (the holder's key address, never the P2SH: a wallet rejects an address that is
//       not one of its accounts with 4100);
//   (2) the wallet's answer is checked AS RETURNED before anything is lifted — signPskt: assertSignedTransactionPreservesIntent
//       (only the requested inputs changed, each now a canonical `41 ‖ sig64 ‖ 01`); signInputs: positional 64-byte raw
//       signatures (128 hex) or 65-byte ones ending 0x01, one per requested input, nothing else accepted;
//   (3) lift bytes [1..66) (signPskt) or append 0x01 to the raw signature (signInputs), re-assert the trailing 0x01, splice
//       into the covenant witness (funding inputs keep the P2PK script);
//   (4) the structural check of every covenant input (push-only, PushMinimal, 4-byte tag, the input's redeem last, no
//       placeholder left) and a final SPLICED-intent check: the signed transaction equals the assembled one in every field
//       except the requested inputs' signature scripts.
// Two wallet shapes, in order of preference: `kaspa_signInputs` (KCC-12 §6.7, raw signatures, the app composes the scripts)
// when the adapter exposes `signInputs`; else `signPskt` sign-and-extract (the path KASPACOM's builder and KaspaRocket run in
// production). Every signature is requested with SIGHASH_ALL. The confirm step lists each covenant input and the successor
// states (`describeSpendV1`). Broadcast is the flow's job (the audited relay/submit helpers are unchanged).
import type { Kaspa } from '../wasm/kaspa.types.js';
import type { WalletAdapter } from '../wallet/types.js';
import { assertSignedTransactionPreservesIntent, canonicalTransactionJson } from './transactionIntent.js';
import { type AssembledFamilyTx, type CovenantSpendV1, applyWalletSignaturesV1, describeSpendV1, massDimsV1, withinCapsV1, MASS_CAP } from './covenantTxKcc20V1.js';

export type FamilySignPath = 'signInputs' | 'signPskt';
export type FamilySignInput = { index: number; address: string; sighashType: 1 };
export type FamilySignRequest = { txJson: string; signInputs: FamilySignInput[]; tokenInputIndexes: number[]; fundingInputIndexes: number[] };
/** Shape-only record of what the wallet answered per requested input (byte length + trailing byte) — for the G0.3 matrix
 *  record and error messages. Never carries signature bytes. */
export type FamilyAnswerShape = { index: number; kind: 'token' | 'funding'; bytes: number; tail: string | null };
export type FamilySignResult = { signedTx: any; signedJson: string; txid: string; path: FamilySignPath; request: FamilySignRequest; answer: FamilyAnswerShape[] };

const SIG64_HEX = /^[0-9a-f]{128}$/i;
const SIG65_HEX = /^[0-9a-f]{130}$/i;

/** The signing ACCOUNT of a holder token input: the address of the key whose signature the witness carries (KCC-20 owner
 *  schemes 0x00 / 0x01 are both key-based, so the account is the P2PK address of `sign.holderPubkey`). */
export function holderAccountAddressV1(k: Kaspa, holderPubkey: Uint8Array, networkId: string): string {
  const kk = k as any;
  const sb = new kk.ScriptBuilder(); sb.addData(holderPubkey).addOp(172);
  return String(kk.addressFromScriptPublicKey(new kk.ScriptPublicKey(0, sb.drain()), networkId).toString());
}

/** (1) The wallet request: the assembled tx with EMPTY signature scripts on every input the wallet signs (funding first, then
 *  the holder's token inputs), each input LABELLED with the address its script derives to (`utxo.address`), and the KCC-12
 *  §6.7 entry list — `index`, `address` = the signing ACCOUNT (a funding input's own address; for a token input the holder's
 *  key address, NOT the covenant's P2SH), `sighashType: 1`. Throws when a funding input carries no address label (assemble
 *  with `networkId`) or a token input has no holder key. */
export function walletRequestV1(k: Kaspa, asm: AssembledFamilyTx, spend: CovenantSpendV1, opts: { networkId?: string } = {}): FamilySignRequest {
  const kk = k as any;
  const tx = kk.Transaction.deserializeFromSafeJSON(asm.transaction.serializeToSafeJSON());
  const inputs = tx.inputs;
  const toSign = [...asm.fundingInputIndexes, ...asm.tokenSignInputIndexes];
  const j = JSON.parse(asm.transaction.serializeToSafeJSON());
  const signInputs: FamilySignInput[] = toSign.map((index) => {
    let address = '';
    const holder = spend.inputs[index]?.sign?.holderPubkey;
    if (holder) {
      if (!opts.networkId) throw new Error(`input ${index}: the holder's account address needs the network id`);
      address = holderAccountAddressV1(k, holder, opts.networkId);
    } else {
      const u = j.inputs?.[index]?.utxo ?? {};
      address = String(u.address ?? '');
      // Safe JSON serializes a utxo's scriptPublicKey as `<4-hex version> ‖ script`; derive the address from the script part.
      const spkHex = typeof u.scriptPublicKey === 'string' ? u.scriptPublicKey.slice(4) : String(u.scriptPublicKey?.script ?? '');
      if (!address && opts.networkId && spkHex) { try { address = String(kk.addressFromScriptPublicKey(new kk.ScriptPublicKey(0, spkHex), opts.networkId)?.toString() ?? ''); } catch { address = ''; } }
      if (!address) throw new Error(`input ${index} has no address label; assemble the transaction with networkId so the wallet can name the account that signs`);
    }
    return { index, address, sighashType: 1 as const };
  });
  for (const i of toSign) inputs[i].signatureScript = '';
  tx.inputs = inputs;
  return { txJson: tx.serializeToSafeJSON(), signInputs, tokenInputIndexes: [...asm.tokenSignInputIndexes], fundingInputIndexes: [...asm.fundingInputIndexes] };
}

/** (2, signInputs) Normalize and check a KCC-12 §6.7 answer: positional `Hex[]` or `{index, signature}[]`, exactly one entry
 *  per requested input, each a 64-byte raw signature (128 hex) or a 65-byte one ending 0x01. Anything else is refused. */
export function normalizeSignInputsAnswerV1(answer: unknown, request: FamilySignRequest): { index: number; signature: string }[] {
  if (!Array.isArray(answer) || answer.length !== request.signInputs.length) throw new Error(`wallet returned ${Array.isArray(answer) ? answer.length : 'no'} signatures for ${request.signInputs.length} requested inputs`);
  const out: { index: number; signature: string }[] = [];
  const seen = new Set<number>();
  answer.forEach((a: any, pos: number) => {
    const positional = typeof a === 'string';
    const index = positional ? request.signInputs[pos].index : Number(a?.index);
    const signature = String(positional ? a : a?.signature ?? '').replace(/^0x/, '').toLowerCase();
    if (!request.signInputs.some((s) => s.index === index) || seen.has(index)) throw new Error(`wallet signed input ${index}, which was not requested (or twice)`);
    seen.add(index);
    if (!(SIG64_HEX.test(signature) || (SIG65_HEX.test(signature) && signature.endsWith('01')))) {
      // Diagnostic shape only — never echo signature bytes.
      throw new Error(`input ${index}: signature is not 64 raw bytes or 65 bytes ending in SIGHASH_ALL (${signature.length / 2}-byte value${SIG65_HEX.test(signature) ? ` ending 0x${signature.slice(-2)}` : ''})`);
    }
    out.push({ index, signature });
  });
  return out;
}

/** (4) The spliced-intent check: the signed transaction equals the assembled one in every field except the requested inputs'
 *  signature scripts — the family twin of assertSignedTransactionPreservesIntent, applied AFTER the covenant witnesses were
 *  rebuilt (so the signed inputs are no longer P2PK-shaped and cannot go through the audited checker). */
export function assertSplicedTransactionPreservesIntentV1(assembledJson: string, signedJson: string, signInputs: readonly number[]): void {
  const a = JSON.parse(assembledJson), b = JSON.parse(signedJson);
  if (!Array.isArray(a?.inputs) || !Array.isArray(b?.inputs) || a.inputs.length !== b.inputs.length) throw new Error('signed transaction changed the input count');
  const allowed = new Set(signInputs);
  for (let i = 0; i < b.inputs.length; i++) {
    if (!allowed.has(i)) continue;
    if (typeof b.inputs[i]?.signatureScript !== 'string' || b.inputs[i].signatureScript.length === 0) throw new Error(`input ${i} is still unsigned after the splice`);
    b.inputs[i].signatureScript = a.inputs[i].signatureScript;
  }
  if (canonicalTransactionJson(a) !== canonicalTransactionJson(b)) throw new Error('the signed transaction differs from the approved intent outside the requested signatures; refusing');
}

/** Sign a family spend with the connected wallet in the D21 order. Throws before any wallet prompt when the tx exceeds a mass
 *  cap or the wallet has no signing capability; refuses an answer that changes anything but the requested signatures. */
export async function signWithWalletV1(k: Kaspa, wallet: WalletAdapter, asm: AssembledFamilyTx, spend: CovenantSpendV1, opts: { networkId: string }): Promise<FamilySignResult> {
  const dims = massDimsV1(k, asm.transaction, opts.networkId, [...asm.fundingInputIndexes, ...asm.tokenSignInputIndexes]);
  if (!withinCapsV1(dims)) throw new Error(`tx mass (compute ${dims.compute}, transient ${dims.transient}, storage ${dims.storage}) exceeds the ${MASS_CAP} consensus cap. Use fewer token pieces or a larger amount`);
  if (wallet.covenantInputSigning === 'refused' && asm.tokenSignInputIndexes.length) throw new Error(`${wallet.label} declines to sign covenant inputs; connect a wallet that supports KCC-12 signing`);
  const request = walletRequestV1(k, asm, spend, { networkId: opts.networkId });
  const assembledJson = asm.transaction.serializeToSafeJSON();
  let signedTx: any, path: FamilySignPath;
  const kindOf = (index: number): 'token' | 'funding' => (request.tokenInputIndexes.includes(index) ? 'token' : 'funding');
  const shapeOfHex = (index: number, h: unknown): FamilyAnswerShape => { const x = String(h ?? '').replace(/^0x/, ''); return { index, kind: kindOf(index), bytes: /^[0-9a-f]*$/i.test(x) ? x.length / 2 : -1, tail: x.length >= 2 ? x.slice(-2).toLowerCase() : null }; };
  let answerShape: FamilyAnswerShape[] = [];
  if (typeof wallet.signInputs === 'function') {
    const answer = await wallet.signInputs(request.txJson, request.signInputs);
    answerShape = Array.isArray(answer) ? answer.map((a: any, pos: number) => shapeOfHex(typeof a === 'string' ? request.signInputs[pos]?.index ?? -1 : Number(a?.index), typeof a === 'string' ? a : a?.signature)) : [];
    const sigs = normalizeSignInputsAnswerV1(answer, request);
    signedTx = applyWalletSignaturesV1(k, asm, spend, sigs);
    path = 'signInputs';
  } else if (typeof wallet.signPskt === 'function') {
    const signedJson = await wallet.signPskt(request.txJson, request.signInputs);
    try { const sj = JSON.parse(signedJson); answerShape = request.signInputs.map(({ index }) => shapeOfHex(index, sj?.inputs?.[index]?.signatureScript)); } catch { answerShape = []; }
    // (2) as returned: only the requested inputs may have changed, and each must now be a canonical P2PK-shaped SIGHASH_ALL
    //     signature script — on the TOKEN inputs too (sign-and-extract relies on the wallet writing `41 ‖ sig64 ‖ 01` there).
    assertSignedTransactionPreservesIntent(request.txJson, signedJson, request.signInputs.map((s) => s.index));
    const signed = JSON.parse(signedJson);
    // (3) lift [1..66), re-assert 0x01, splice — applyWalletSignaturesV1 → liftSignature65 / withSignature
    signedTx = applyWalletSignaturesV1(k, asm, spend, request.signInputs.map(({ index }) => ({ index, signatureScript: String(signed.inputs[index]?.signatureScript ?? '') })));
    path = 'signPskt';
  } else {
    throw new Error(`${wallet.label} cannot sign KRON transactions (no signInputs / signPskt). Connect a signing-capable wallet`);
  }
  // (4) applyWalletSignaturesV1 ran the structural check; now the spliced-intent check against the ASSEMBLED transaction.
  const signedJson = signedTx.serializeToSafeJSON();
  assertSplicedTransactionPreservesIntentV1(assembledJson, signedJson, request.signInputs.map((s) => s.index));
  const txid = String(signedTx.id?.toString?.() ?? signedTx.id ?? '');
  if (!txid) throw new Error('signed transaction has no id');
  return { signedTx, signedJson, txid, path, request, answer: answerShape };
}

/** The confirm-step summary (covenant inputs, which ones the wallet signs, and every leader's `next_states`). */
export const confirmSummaryV1 = describeSpendV1;

// SDK addition (0.20): the post-signing SIGHASH_ALL assertion lives beside the signing path it checks.
export { assertSighashAllV1, SIGHASH_ALL, type SighashAllReportV1 } from './sighashV1.js';
