// kcc20v1 (KCC-20 standard) family — the compiled-template shape the family builders take, and the adapter from the
// KRON registry server's compile answer (`POST /api/native/kcc20v1-template`) to it. This SDK carries no compiler
// (see index.ts): the server compiles the token's PINNED covenant version with its baked parameters and answers one
// program per key (`token`, `curve`, `pool`, `order`), each as bytecode + state span + the KCC-1 template hash + the
// dispatch tags per entry. `compiledFromServerV1` rebuilds prefix / suffix from the span and RECOMPUTES the KCC-1 §3.7.3
// template hash (BLAKE3 over `LE64(len(prefix)) ‖ prefix ‖ LE64(len(suffix)) ‖ suffix`); a mismatch throws, so a wrong
// or tampered answer never reaches an address derivation. Mirrors kron's web/src/native/compiledFromServerV1.ts.
import { blake3 } from '@noble/hashes/blake3.js';

/** One compiled family program, as the builders' `*TemplateFromCompiledV1` helpers take it. */
export type CompiledV1 = {
  name: string;
  bytecode: Uint8Array; bytecodeHex: string;
  stateSpan: { offset: number; len: number };
  prefix: Uint8Array; suffix: Uint8Array;
  templateHash: string;                 // hex, recomputed == claimed
  dispatchTags: Record<string, string>; // entry → 4-byte tag hex
  artifact: any;                        // the parsed SilAbiArtifact when the compile ran locally; null from the server
};

export const hexV1 = (u8: Uint8Array | number[]): string => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
export const bytesOfHexV1 = (h: string): Uint8Array => {
  const s = String(h).replace(/^0x/, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error(`bad hex: ${String(h).slice(0, 20)}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const concat = (...a: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let p = 0; for (const x of a) { out.set(x, p); p += x.length; }
  return out;
};
const le64 = (n: number): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
/** KCC-1 §3.7.3 template hash over the template parts. */
export const templateHashV1 = (prefix: Uint8Array, suffix: Uint8Array): Uint8Array =>
  blake3(concat(le64(prefix.length), prefix, le64(suffix.length), suffix));

/** One program of the server's answer (backend/kcc20v1/templates.mjs compileFamilyTemplatesV1). */
export type ServerCompiledProgramV1 = { name?: string; bytecodeHex: string; stateSpan: { offset: number; len: number }; prefixLen?: number; suffixLen?: number; templateHash: string; dispatchTags?: Record<string, string> };
/** The `POST /api/native/kcc20v1-template` response: the four programs (+ the compiler's params echo). */
export type FamilyTemplatesResponseV1 = { token: ServerCompiledProgramV1; curve: ServerCompiledProgramV1; pool: ServerCompiledProgramV1; order: ServerCompiledProgramV1; params?: Record<string, unknown>; [key: string]: unknown };

export function compiledFromServerV1(name: string, p: ServerCompiledProgramV1): CompiledV1 {
  if (!p || typeof p.bytecodeHex !== 'string' || !p.stateSpan) throw new Error(`${name}: malformed server template`);
  const bytecode = bytesOfHexV1(p.bytecodeHex);
  const offset = Number(p.stateSpan.offset), len = Number(p.stateSpan.len);
  if (!(offset >= 0 && len >= 0 && offset + len <= bytecode.length)) throw new Error(`${name}: state span out of range`);
  const prefix = bytecode.slice(0, offset), suffix = bytecode.slice(offset + len);
  if (p.prefixLen != null && Number(p.prefixLen) !== prefix.length) throw new Error(`${name}: prefix length ${p.prefixLen} disagrees with the state span`);
  if (p.suffixLen != null && Number(p.suffixLen) !== suffix.length) throw new Error(`${name}: suffix length ${p.suffixLen} disagrees with the state span`);
  const claimed = String(p.templateHash).replace(/^0x/, '').toLowerCase();
  const recomputed = hexV1(templateHashV1(prefix, suffix));
  if (claimed !== recomputed) throw new Error(`${name}: server template hash ${claimed.slice(0, 12)}… != KCC-1 recomputation ${recomputed.slice(0, 12)}…`);
  const dispatchTags: Record<string, string> = {};
  for (const [fn, t] of Object.entries(p.dispatchTags ?? {})) dispatchTags[fn] = String(t).replace(/^0x/, '').toLowerCase();
  return { name: p.name ?? name, bytecode, bytecodeHex: hexV1(bytecode), stateSpan: { offset, len }, prefix, suffix, templateHash: claimed, dispatchTags, artifact: null };
}
export const familyFromServerV1 = (r: FamilyTemplatesResponseV1): { token: CompiledV1; curve: CompiledV1; pool: CompiledV1; order: CompiledV1 } =>
  ({ token: compiledFromServerV1('token', r.token), curve: compiledFromServerV1('curve', r.curve), pool: compiledFromServerV1('pool', r.pool), order: compiledFromServerV1('order', r.order) });
