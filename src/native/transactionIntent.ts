// Wallets are an untrusted signing boundary. They may add signatures only to the exact funding inputs KRON
// requested; every other transaction field must remain byte-for-byte equivalent to the reviewed Safe JSON.

/** The canonical serialization the intent check compares (sorted keys, recursive). Exported for the kcc20v1 family's
 *  spliced-intent check (native/spendV1.ts), which must apply the SAME equality rule after it rebuilds covenant witnesses. */
export function canonicalTransactionJson(value: unknown): string { return canonical(value); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

function parsed(value: string): any {
  try { return JSON.parse(value); }
  catch { throw new Error('wallet returned malformed transaction JSON'); }
}

export function assertSignedTransactionPreservesIntent(
  unsignedJson: string,
  signedJson: string,
  signInputs: readonly number[],
): void {
  const unsigned = parsed(unsignedJson);
  const signed = parsed(signedJson);
  if (!Array.isArray(unsigned?.inputs) || !Array.isArray(signed?.inputs)) {
    throw new Error('wallet transaction is missing its inputs');
  }
  if (unsigned.inputs.length !== signed.inputs.length) {
    throw new Error('wallet changed the transaction input count');
  }
  const allowed = new Set<number>();
  for (const index of signInputs) {
    if (!Number.isInteger(index) || index < 0 || index >= unsigned.inputs.length || allowed.has(index)) {
      throw new Error(`invalid wallet signing input index ${index}`);
    }
    allowed.add(index);
  }
  // Normalize only the requested signatureScript fields. Covenant scripts and every non-signature field remain
  // part of the equality check, so a wallet cannot redirect outputs, change fees, inputs, payload, or lock time.
  for (let i = 0; i < signed.inputs.length; i++) {
    if (allowed.has(i)) {
      const script = signed.inputs[i]?.signatureScript;
      // Standard P2PK funding input: PUSH65 <64-byte Schnorr signature || one-byte sighash>. KRON asks the
      // wallet for SIGHASH_ALL (0x01); enforcing the returned suffix prevents a wallet/provider from weakening
      // output commitment with NONE/SINGLE/ANYONECANPAY before we normalize this field for intent equality.
      if (typeof script !== 'string' || !/^41[0-9a-f]{130}$/i.test(script) || !script.toLowerCase().endsWith('01')) {
        // Diagnostic shape only (length + trailing sighash byte) — NEVER echo the signature bytes themselves.
        const shape =
          typeof script !== 'string' ? 'a non-string signatureScript'
          : script.length === 0 ? 'an unsigned (empty) input'
          : script.length % 2 !== 0 || /[^0-9a-f]/i.test(script) ? 'a non-hex signatureScript'
          : `a ${script.length / 2}-byte script ending 0x${script.slice(-2).toLowerCase()}`;
        throw new Error(`wallet returned a funding signature without canonical SIGHASH_ALL (input ${i}: ${shape})`);
      }
      signed.inputs[i].signatureScript = unsigned.inputs[i].signatureScript;
    }
  }
  if (canonical(unsigned) !== canonical(signed)) {
    throw new Error('wallet changed the approved transaction intent; refusing to broadcast');
  }
}
