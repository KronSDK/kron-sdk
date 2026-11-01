// kcc20v1 (KCC-20 standard) family — the pure codec surface against the OFFICIAL conformance vectors (KCC-1 covenant ABI,
// KCC-20 reference token; __fixtures__/kccs, mirrored from the KCCs repository) and the compiled-template adapter against
// the fixture compiled by silverc v1.0.0 (__fixtures__/kcc20v1-templates.json, written by scripts/verify-parity-v1.mjs).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dispatchTagV1, familyTagsV1, TOKEN_DISPATCH_TAGS, FAMILY_SIGNATURES, hexOf, bytesOfHex } from './dispatchTag.js';
import { templateHashV1, compiledFromServerV1, familyFromServerV1, hexV1, bytesOfHexV1 } from './templatesV1.js';
import { int8SM, int8SMDecode, pushExplicit, encodeKcc20V1State, decodeKcc20V1State, materializeKcc20V1Script, tokenTemplateFromCompiledV1, KCC20V1_STATE_LEN, KCC20V1_FRAMING, OWNER_SCHEME, ZERO32, authorityV1, leaderWitnessV1, type Kcc20V1State } from './kcc20V1Tx.js';
import { pushMinimalV1, parsePushesV1 } from './covenantTxKcc20V1.js';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const KCC1 = read('./__fixtures__/kccs/kcc-0001.conformance.json');
const KCC20 = read('./__fixtures__/kccs/kcc-0020.conformance.json');
const FX = read('./__fixtures__/kcc20v1-templates.json');
const payloadOf = (p: any): Uint8Array => (p.hex != null ? bytesOfHex(p.hex) : new Uint8Array(p.count).fill(parseInt(p.repeat_hex, 16)));
const encodedOf = (e: any, payload: Uint8Array): string => (e.hex != null ? e.hex : e.encoded_prefix_hex + hexOf(payload));
const utf8 = (hex: string) => new TextDecoder().decode(bytesOfHex(hex));
const vecState = (s: any): Kcc20V1State => ({ amount: BigInt(s.amount), owner: bytesOfHex(s.owner_hex), ownerScheme: parseInt(s.owner_scheme_hex, 16), borrowScheme: parseInt(s.borrow_scheme_hex, 16), borrowGuard: bytesOfHex(s.borrow_guard_hex), extensionCommitment: bytesOfHex(s.extension_commitment_hex) });

describe('KCC-1 conformance vectors', () => {
  it('§3.5.1 dispatch tags = blake3(signature)[0..4]', () => {
    const d = KCC1.dispatch_and_arguments;
    expect(hexOf(dispatchTagV1(utf8(d.function_signature_utf8_hex)))).toBe(d.dispatch_tag_hex);
    const z = KCC1.zero_argument_dispatch;
    expect(hexOf(dispatchTagV1(utf8(z.function_signature_utf8_hex)))).toBe(z.dispatch_tag_hex);
    for (const r of KCC1.record_dispatch) expect(hexOf(dispatchTagV1(utf8(r.function_signature_utf8_hex)))).toBe(r.dispatch_tag_hex);
  });
  it('§3.4.2 data pushes: PushExplicit (arguments / state) and PushMinimal (the invocation check)', () => {
    for (const v of KCC1.data_pushes) {
      const payload = payloadOf(v.payload);
      expect(hexOf(pushExplicit(payload)), v.id).toBe(encodedOf(v.push_explicit, payload));
      expect(hexOf(pushMinimalV1(payload)), v.id).toBe(encodedOf(v.push_minimal, payload));
    }
  });
  it('§3.4.3 int8 signed-magnitude LE state payloads, and the decoder inverts them', () => {
    const ints = KCC1.scalar_encodings.filter((s: any) => s.type === 'int' && s.value_decimal == null);
    expect(ints.length).toBeGreaterThan(5);
    for (const s of ints) {
      expect(hexOf(int8SM(BigInt(s.value))), String(s.value)).toBe(s.state_payload_hex);
      expect(int8SMDecode(bytesOfHex(s.state_payload_hex))).toBe(BigInt(s.value));
    }
    for (const s of KCC1.scalar_encodings.filter((s: any) => s.type === 'int' && s.value_decimal != null)) expect(hexOf(int8SM(BigInt(s.value_decimal)))).toBe(s.state_payload_hex);
    for (const r of KCC1.rejection_vectors.filter((r: any) => r.operation === 'encode_scalar' && r.type === 'int')) expect(() => int8SM(BigInt(r.value_decimal)), r.id).toThrow();
  });
  it('§3.7.3 template hashes over LE64|prefix|‖prefix‖LE64|suffix|‖suffix, including the template views', () => {
    for (const v of KCC1.template_hashes) expect(hexV1(templateHashV1(bytesOfHexV1(v.prefix_hex), bytesOfHexV1(v.suffix_hex)))).toBe(v.hash_hex);
    for (const v of KCC1.template_views.views) expect(hexV1(templateHashV1(bytesOfHexV1(v.prefix_hex), bytesOfHexV1(v.suffix_hex)))).toBe(v.template_hash_hex);
  });
});

describe('KCC-20 conformance vectors', () => {
  it('the reference token dispatch tags and signatures', () => {
    const tags = familyTagsV1('token');
    expect(tags).toEqual(TOKEN_DISPATCH_TAGS);
    for (const d of KCC20.dispatch) {
      expect(FAMILY_SIGNATURES.token[d.entrypoint as 'transfer' | 'transfer_delegator']).toBe(d.function_signature);
      expect(tags[d.entrypoint]).toBe(d.dispatch_tag_hex);
    }
    expect(KCC20.state_record.dispatch_type_name).toBe('{int,byte[32],byte,byte,byte[32],byte[32]}');
  });
  it('the 112-byte state record encoding (after the 33-byte template field KRON prefixes)', () => {
    const v = KCC20.state_encoding;
    const enc = encodeKcc20V1State(ZERO32, vecState(v.state));
    expect(enc.length).toBe(KCC20V1_STATE_LEN);
    expect(KCC20V1_STATE_LEN).toBe(33 + KCC20.state_record.encoded_state_length);
    expect(hexOf(enc.slice(33))).toBe(v.encoded_hex);
    expect(v.encoded_fields_hex.join('')).toBe(v.encoded_hex);
    expect(KCC20V1_FRAMING.map(([o, b]) => `${o}:${b.toString(16)}`)).toEqual(['0:20', '33:8', '42:20', '75:1', '77:1', '79:20', '112:20']);
  });
  it('owner witnesses: leader = 0x00 ‖ authority for p2pk-schnorr (65) and p2pkh-schnorr (32 ‖ 65)', () => {
    const sig65 = new Uint8Array(65).fill(0x44), pub = new Uint8Array(32).fill(0x22);
    const [p2pk, p2pkh] = KCC20.owner_witness;
    const piece0: Kcc20V1State = { amount: 1n, owner: pub, ownerScheme: OWNER_SCHEME.P2PK_SCHNORR, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32 };
    expect(hexOf(leaderWitnessV1(authorityV1(piece0, sig65)))).toBe(p2pk.witness_hex);
    expect(p2pk.length).toBe(66);
    const piece1: Kcc20V1State = { ...piece0, ownerScheme: OWNER_SCHEME.P2PKH_SCHNORR, owner: bytesOfHex(p2pkh.p2pkh_hash_hex) };
    expect(hexOf(leaderWitnessV1(authorityV1(piece1, sig65, pub)))).toBe(p2pkh.witness_hex);
    expect(p2pkh.length).toBe(98);
    expect(() => authorityV1(piece0, sig65.slice(0, 64))).toThrow(/65-byte/);
    expect(hexOf(authorityV1({ ...piece0, ownerScheme: OWNER_SCHEME.COVENANT_ID }, null))).toBe('');
  });
});

describe('compiled templates (silverc v1.0.0 fixture) and the server adapter', () => {
  it('the compiler\'s dispatch tags equal the tags derived from the entry signatures, for all four programs', () => {
    for (const p of ['token', 'curve', 'pool', 'order'] as const) expect(FX[p].dispatchTags, p).toEqual(familyTagsV1(p));
  });
  it('compiledFromServerV1 recomputes the KCC-1 template hash and rebuilds prefix / suffix from the state span', () => {
    const c = familyFromServerV1(FX);
    for (const p of ['token', 'curve', 'pool', 'order'] as const) {
      expect(c[p].templateHash).toBe(FX[p].templateHash);
      expect(c[p].prefix.length).toBe(FX[p].prefixLen);
      expect(c[p].suffix.length).toBe(FX[p].suffixLen);
      expect(c[p].bytecode.length).toBe(FX[p].bytecodeHex.length / 2);
      expect(hexV1(templateHashV1(c[p].prefix, c[p].suffix))).toBe(FX[p].templateHash);
    }
    expect(c.token.templateHash).toBe('9703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7'); // the reference token program
    expect(c.token.bytecode.length).toBe(4031);
    expect(c.token.stateSpan).toEqual({ offset: 1, len: 145 });
  });
  it('refuses a tampered or malformed answer before any address is derived', () => {
    const t = FX.token;
    expect(() => compiledFromServerV1('token', { ...t, templateHash: '00'.repeat(32) })).toThrow(/KCC-1 recomputation/);
    expect(() => compiledFromServerV1('token', { ...t, bytecodeHex: t.bytecodeHex.slice(0, -2) + 'ff' })).toThrow(/KCC-1 recomputation/);
    expect(() => compiledFromServerV1('token', { ...t, stateSpan: { offset: 4000, len: 145 } })).toThrow(/out of range/);
    expect(() => compiledFromServerV1('token', { ...t, prefixLen: 2 })).toThrow(/prefix length/);
    expect(() => compiledFromServerV1('token', { ...t, suffixLen: 1 })).toThrow(/suffix length/);
    expect(() => compiledFromServerV1('token', { ...t, bytecodeHex: 'zz' })).toThrow(/bad hex/);
    expect(() => compiledFromServerV1('token', { stateSpan: t.stateSpan } as any)).toThrow(/malformed/);
  });
  it('a token redeem script round-trips through materialize → decode, and framing corruption is refused', () => {
    const tpl = tokenTemplateFromCompiledV1(compiledFromServerV1('token', FX.token));
    const s: Kcc20V1State = { amount: 123_456_789n, owner: new Uint8Array(32).fill(0x11), ownerScheme: 0, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: new Uint8Array(32).fill(0x7e) };
    const redeem = materializeKcc20V1Script(tpl, s);
    expect(redeem.length).toBe(tpl.prefix.length + KCC20V1_STATE_LEN + tpl.suffix.length);
    const d = decodeKcc20V1State(redeem);
    expect(hexOf(d.templateHash)).toBe(FX.token.templateHash);
    expect(d.state.amount).toBe(s.amount); expect(hexOf(d.state.owner)).toBe(hexOf(s.owner)); expect(d.state.ownerScheme).toBe(0); expect(hexOf(d.state.extensionCommitment)).toBe(hexOf(s.extensionCommitment));
    const bad = redeem.slice(); bad[1 + 33] = 0x09; // the amount field's length byte
    expect(() => decodeKcc20V1State(bad)).toThrow();
    // the pushes the materialized script ends with are what parsePushesV1 reads back (no non-push opcode inside the state)
    expect(parsePushesV1(redeem.slice(1, 1 + KCC20V1_STATE_LEN)).length).toBe(7);
  });
});
