// kcc20v1 (KCC-20 standard) family — the SIGHASH_ALL assertion over a SIGNED family transaction (SDK addition, 0.20; the
// kron gate verify:kcc20v1-sighash proves the same facts against the VM). KCC-20 owner witnesses are 65-byte Schnorr
// signatures whose last byte is the sighash type, and the covenant checks `sig[64] == 0x01` itself (G0.3: 64 / 66 / 0 byte
// witnesses are refused by the token program). A wallet that signs with another sighash type, or returns a bare 64-byte
// signature that a careless caller splices as-is, produces a transaction consensus rejects AFTER the user approved it. Run
// this on the signed transaction before submitting: it finds every signature the wallet produced — the P2PK funding inputs
// (`41 ‖ sig64 ‖ 01`) and the holder token inputs' witness push (`00 ‖ authority` on the leader, the authority alone on a
// delegator; authority = sig65 for scheme 0, sig65 ‖ pubkey32 for scheme 1, sig65 ‖ pubkey33 for scheme 2) — and refuses
// any whose signature does not end in 0x01, is missing, or is ambiguous. Pure: parses the signature-script hex only.
import { parsePushesV1 } from './covenantTxKcc20V1.js';
import { bytesOfHex } from './dispatchTag.js';

export const SIGHASH_ALL = 0x01;
/** Witness push lengths: leader = 0x00 ‖ authority, delegator = authority; authority = 65 | 65+32 | 65+33 bytes. */
const AUTHORITY_LENGTHS = new Set([65, 97, 98]);
const LEADER_LENGTHS = new Set([66, 98, 99]);

export type SighashAllReportV1 = { index: number; kind: 'funding' | 'token'; witness: 'p2pk' | 'leader' | 'delegator'; bytes: number };

/** Assert every wallet-produced signature of a signed family tx is SIGHASH_ALL. `tx` is the signed transaction (SDK object
 *  or its Safe JSON string); `roles` are the index lists `assembleFamilyTx` returned. Returns one record per checked input. */
export function assertSighashAllV1(tx: any, roles: { fundingInputIndexes: readonly number[]; tokenSignInputIndexes: readonly number[] }): SighashAllReportV1[] {
  const j = typeof tx === 'string' ? JSON.parse(tx) : typeof tx?.serializeToSafeJSON === 'function' ? JSON.parse(tx.serializeToSafeJSON()) : tx;
  if (!Array.isArray(j?.inputs)) throw new Error('assertSighashAllV1: not a transaction (no inputs)');
  const scriptOf = (i: number): Uint8Array => {
    const s = j.inputs[i]?.signatureScript;
    if (typeof s !== 'string' || s.length === 0) throw new Error(`input ${i}: unsigned (empty signature script)`);
    return bytesOfHex(s);
  };
  const out: SighashAllReportV1[] = [];
  for (const i of roles.fundingInputIndexes) {
    const pushes = parsePushesV1(scriptOf(i));
    if (pushes.length !== 1 || pushes[0].payload.length !== 65) throw new Error(`input ${i} (funding): expected one 65-byte signature push, got ${pushes.map((p) => p.payload.length).join('/') || 'nothing'}`);
    if (pushes[0].payload[64] !== SIGHASH_ALL) throw new Error(`input ${i} (funding): signature sighash byte 0x${pushes[0].payload[64].toString(16).padStart(2, '0')} is not SIGHASH_ALL (0x01)`);
    out.push({ index: i, kind: 'funding', witness: 'p2pk', bytes: 65 });
  }
  for (const i of roles.tokenSignInputIndexes) {
    const pushes = parsePushesV1(scriptOf(i));
    // the invocation ends `… tag(4) redeem`; the witness is the argument push right before the tag on both entries
    if (pushes.length < 3) throw new Error(`input ${i} (token): invocation needs a witness, a tag and a redeem push`);
    const w = pushes[pushes.length - 3].payload;
    let witness: 'leader' | 'delegator', authority: Uint8Array;
    if (LEADER_LENGTHS.has(w.length) && w[0] === 0x00) { witness = 'leader'; authority = w.slice(1); }
    else if (AUTHORITY_LENGTHS.has(w.length)) { witness = 'delegator'; authority = w; }
    else throw new Error(`input ${i} (token): witness push is ${w.length} bytes — not a KCC-20 owner witness (65/97/98, or 0x00-prefixed on the leader)`);
    if (authority.every((b) => b === 0)) throw new Error(`input ${i} (token): witness is still the zero placeholder (unsigned)`);
    if (authority[64] !== SIGHASH_ALL) throw new Error(`input ${i} (token, ${witness}): signature sighash byte 0x${authority[64].toString(16).padStart(2, '0')} is not SIGHASH_ALL (0x01)`);
    out.push({ index: i, kind: 'token', witness, bytes: w.length });
  }
  return out;
}
