// kcc20v1 (KCC-20 standard) family — reference-token state, redeem materialization and signature scripts
// (docs/kcc20v1/PLAN.md §5 "Web and SDK"). The family twin of ./kcc20Tx.ts (frozen, audited 46-byte family).
//
// A token balance is a P2SH UTXO whose redeem script is the reference program with a 145-byte state span at offset 1
// (KCC-1 §3.7.1, canonical PushExplicit per field, framing 20|08|20|01|01|20|20):
//   [20 template32] [08 amount] [20 owner32] [01 owner_scheme] [01 borrow_scheme] [20 borrow_guard32] [20 extension32]
// Everything outside the span is the token's template (prefix ‖ suffix), so a balance's redeem is produced by
// SPLICING — never by recompiling. `transfer(KCC20State[] next_states, byte[] witness)` is the leader entry: the
// record array lowers to SIX grouped pushes (KCC-1 §3.4.6), the witness is `path ‖ authority` (path 00 = normal),
// then the 4-byte dispatch tag, then the redeem. `transfer_delegator(byte[] witness)` carries the authority bytes
// only (no path byte). Covenant-id owners (the curve's inventory, the pool's reserve) authorize with an empty
// authority, so a covenant-owned leader pushes `01 00` and a covenant-owned delegator pushes OP_0.
// No top-level SDK import (only `import type`) — the caller passes the loaded WASM namespace `k`.
import type { Kaspa } from '../wasm/kaspa.types.js';
import { SigScriptBuilder } from './sigscript.js';
import { TOKEN_DISPATCH_TAGS, assertFamilyTagsV1, bytesOfHex, hexOf } from './dispatchTag.js';
import type { CompiledV1 } from './templatesV1.js';

type K = Kaspa;
type Spk = any;

export const KCC20V1_STATE_LEN = 145;
export const KCC20V1_STATE_OFFSET = 1;
export const OWNER_SCHEME = { P2PK_SCHNORR: 0, P2PKH_SCHNORR: 1, P2PKH_ECDSA: 2, P2SH: 3, COVENANT_ID: 4 } as const;
export const BORROW_SCHEME = { DISABLED: 0, AMOUNT_THRESHOLD: 1, SCHNORR_SIGNATURE: 2, HASH_CHAIN: 3 } as const;
export const ZERO32 = new Uint8Array(32);
export const SIG65_LEN = 65;

/** A reference-token balance (the six KCC20State fields). All byte strings are raw 32-byte arrays. */
export type Kcc20V1State = {
  amount: bigint;
  owner: Uint8Array;
  ownerScheme: number;
  borrowScheme: number;
  borrowGuard: Uint8Array;
  extensionCommitment: Uint8Array;
};
/** A token build: template parts + KCC-1 template hash + the two dispatch tags (from the compiled artifact). */
export type Kcc20V1Template = { prefix: Uint8Array; suffix: Uint8Array; templateHash: Uint8Array; tags: { transfer: Uint8Array; transfer_delegator: Uint8Array } };

/** Build a token template from a compiled artifact (compileTemplatesV1.ts), refusing unknown dispatch tags. */
export function tokenTemplateFromCompiledV1(c: CompiledV1): Kcc20V1Template {
  const tags = assertFamilyTagsV1('token', c.dispatchTags);
  if (hexOf(tags.transfer) !== TOKEN_DISPATCH_TAGS.transfer || hexOf(tags.transfer_delegator) !== TOKEN_DISPATCH_TAGS.transfer_delegator) throw new Error('token dispatch tags differ from the reference program');
  if (c.stateSpan.offset !== KCC20V1_STATE_OFFSET || c.stateSpan.len !== KCC20V1_STATE_LEN) throw new Error(`token state span {${c.stateSpan.offset},${c.stateSpan.len}} is not the reference layout {1,145}`);
  return { prefix: c.prefix, suffix: c.suffix, templateHash: bytesOfHex(c.templateHash), tags: { transfer: tags.transfer, transfer_delegator: tags.transfer_delegator } };
}

// --- KCC-1 payload encodings ----------------------------------------------------------------------------------
const INT_MAX = (1n << 63n) - 1n;
/** §3.4.3 fixed-width int: 8 bytes little-endian magnitude, sign bit = top bit of the last byte. */
export function int8SM(v: bigint): Uint8Array {
  const neg = v < 0n; let m = neg ? -v : v;
  if (m > INT_MAX) throw new Error(`int ${v} outside ±(2^63-1)`);
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { b[i] = Number(m & 0xffn); m >>= 8n; }
  if (neg) b[7] |= 0x80;
  return b;
}
/** The inverse of int8SM: 8 bytes little-endian magnitude, sign bit = top bit of the last byte. */
export function int8SMDecode(b: Uint8Array): bigint {
  if (b.length !== 8) throw new Error(`int8 field must be 8 bytes (got ${b.length})`);
  const neg = (b[7] & 0x80) !== 0;
  let m = 0n;
  for (let i = 7; i >= 0; i--) m = (m << 8n) | BigInt(i === 7 ? b[7] & 0x7f : b[i]);
  return neg ? -m : m;
}
/** The 145-byte state framing of the reference token: [20 tpl32] [08 amount8] [20 owner32] [01 scheme] [01 bscheme] [20 guard32] [20 ext32]. */
export const KCC20V1_FRAMING: ReadonlyArray<readonly [number, number]> = [[0, 0x20], [33, 0x08], [42, 0x20], [75, 0x01], [77, 0x01], [79, 0x20], [112, 0x20]];
/** Decode the state span of a reference-token redeem script (the inverse of encodeKcc20V1State), asserting the framing.
 *  Used on the indexer's `redeemScriptHex` rows so a holder's piece is spent with EXACTLY the owner / borrow settings the
 *  chain holds (PLAN D2: change and merged pieces copy them). */
export function decodeKcc20V1State(redeem: Uint8Array, offset = KCC20V1_STATE_OFFSET): { templateHash: Uint8Array; state: Kcc20V1State } {
  const s = redeem.subarray(offset, offset + KCC20V1_STATE_LEN);
  if (s.length !== KCC20V1_STATE_LEN) throw new Error(`redeem too short for a ${KCC20V1_STATE_LEN}-byte state at offset ${offset}`);
  for (const [pos, len] of KCC20V1_FRAMING) if (s[pos] !== len) throw new Error(`state framing byte at ${pos} is 0x${s[pos].toString(16).padStart(2, '0')}, expected 0x${len.toString(16).padStart(2, '0')}`);
  const state: Kcc20V1State = {
    amount: int8SMDecode(s.slice(34, 42)), owner: s.slice(43, 75), ownerScheme: s[76], borrowScheme: s[78],
    borrowGuard: s.slice(80, 112), extensionCommitment: s.slice(113, 145),
  };
  return { templateHash: s.slice(1, 33), state };
}
/** §3.4.2 PushExplicit: a data push that never uses the small-integer opcodes. */
export function pushExplicit(p: Uint8Array): Uint8Array {
  const n = p.length;
  if (n === 0) return Uint8Array.of(0x00);
  if (n <= 75) return concat([Uint8Array.of(n), p]);
  if (n <= 255) return concat([Uint8Array.of(0x4c, n), p]);
  if (n <= 65535) return concat([Uint8Array.of(0x4d, n & 0xff, n >> 8), p]);
  return concat([Uint8Array.of(0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff), p]);
}
export const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const b32 = (what: string, u8: Uint8Array): Uint8Array => { if (u8.length !== 32) throw new Error(`${what} must be 32 bytes`); return u8; };

/** Reject states the covenants would never create and strangers must never be handed (PLAN D2 rules 2–3 are the
 *  builders' job; this is the floor every caller gets): unassigned schemes are permanently unspendable, a zero
 *  covenant-id owner is anyone-can-spend, negative amounts fail conservation. */
export function assertSpendableKcc20V1State(s: Kcc20V1State): void {
  if (!Number.isInteger(s.ownerScheme) || s.ownerScheme < 0 || s.ownerScheme > OWNER_SCHEME.COVENANT_ID) throw new Error(`owner scheme must be 0x00–0x04 (got ${s.ownerScheme}); the token refuses every spend of an unassigned scheme`);
  if (!Number.isInteger(s.borrowScheme) || s.borrowScheme < 0 || s.borrowScheme > BORROW_SCHEME.HASH_CHAIN) throw new Error(`borrow scheme must be 0x00–0x03 (got ${s.borrowScheme})`);
  if (s.amount < 0n) throw new Error('amount must be non-negative');
  b32('owner', s.owner); b32('borrow_guard', s.borrowGuard); b32('extension_commitment', s.extensionCommitment);
  if (s.ownerScheme === OWNER_SCHEME.COVENANT_ID && s.owner.every((x) => x === 0)) throw new Error('covenant-id owner must not be all-zero: OpInputCovenantId returns the zero hash for any ordinary input, making the balance anyone-can-spend');
}

/** The 145-byte state span for `s` under template hash `tpl`. */
export function encodeKcc20V1State(tplHash: Uint8Array, s: Kcc20V1State): Uint8Array {
  assertSpendableKcc20V1State(s);
  return concat([
    pushExplicit(b32('template hash', tplHash)), pushExplicit(int8SM(s.amount)), pushExplicit(s.owner),
    pushExplicit(Uint8Array.of(s.ownerScheme)), pushExplicit(Uint8Array.of(s.borrowScheme)), pushExplicit(s.borrowGuard), pushExplicit(s.extensionCommitment),
  ]);
}
/** A balance's redeem script: prefix ‖ state ‖ suffix (byte-identical to silverc at that state). */
export const materializeKcc20V1Script = (tpl: Kcc20V1Template, s: Kcc20V1State): Uint8Array => concat([tpl.prefix, encodeKcc20V1State(tpl.templateHash, s), tpl.suffix]);
export const kcc20V1Spk = (k: K, redeem: Uint8Array): Spk => (k as any).payToScriptHashScript(redeem);
export const kcc20V1SpkForState = (k: K, tpl: Kcc20V1Template, s: Kcc20V1State): Spk => kcc20V1Spk(k, materializeKcc20V1Script(tpl, s));
export const kcc20V1Address = (k: K, tpl: Kcc20V1Template, s: Kcc20V1State, network: string): string =>
  (k as any).addressFromScriptPublicKey(kcc20V1SpkForState(k, tpl, s), network)?.toString() ?? '';

// --- state constructors (PLAN D2: new pieces get defaults; covenant-owned state is deterministic) ----------------
/** A balance owned by covenant `covid` (0x04): the curve's inventory, the pool's reserve, the pool's LP inventory. */
export const covenantOwnedV1 = (covid32: Uint8Array, amount: bigint, extensionCommitment: Uint8Array = ZERO32): Kcc20V1State =>
  ({ amount, owner: b32('covid', covid32), ownerScheme: OWNER_SCHEME.COVENANT_ID, borrowScheme: BORROW_SCHEME.DISABLED, borrowGuard: ZERO32, extensionCommitment });
/** A NEW holder piece (rule 3): p2pk-schnorr owner, borrowing disabled, zero guard. */
export const p2pkOwnedV1 = (pubkey32: Uint8Array, amount: bigint, extensionCommitment: Uint8Array = ZERO32): Kcc20V1State =>
  ({ amount, owner: b32('pubkey', pubkey32), ownerScheme: OWNER_SCHEME.P2PK_SCHNORR, borrowScheme: BORROW_SCHEME.DISABLED, borrowGuard: ZERO32, extensionCommitment });
/** An EXISTING holder's change or merged piece (rule 4): every setting copied from the piece they spend. */
export const changeLikeV1 = (piece: Kcc20V1State, amount: bigint, extensionCommitment: Uint8Array): Kcc20V1State =>
  ({ amount, owner: piece.owner, ownerScheme: piece.ownerScheme, borrowScheme: piece.borrowScheme, borrowGuard: piece.borrowGuard, extensionCommitment });

/** Only p2pk-schnorr and p2pkh-schnorr holders can trade through the family covenants (rule 4); the holder's
 *  identity is the x-only key, compared directly (0x00) or through BLAKE3 (0x01). Returns the key the wallet signs with. */
export function assertHolderPieceV1(piece: Kcc20V1State, holderPubkey: Uint8Array, blake3Of: (b: Uint8Array) => Uint8Array): void {
  b32('holder pubkey', holderPubkey);
  if (piece.ownerScheme === OWNER_SCHEME.P2PK_SCHNORR) { if (hexOf(piece.owner) !== hexOf(holderPubkey)) throw new Error('this token piece is not owned by the connected wallet key'); return; }
  if (piece.ownerScheme === OWNER_SCHEME.P2PKH_SCHNORR) { if (hexOf(piece.owner) !== hexOf(blake3Of(holderPubkey))) throw new Error('this token piece is not owned by the connected wallet key (p2pkh)'); return; }
  throw new Error(`token pieces owned under scheme 0x${piece.ownerScheme.toString(16).padStart(2, '0')} cannot be traded here — only p2pk-schnorr and p2pkh-schnorr holders can sell or merge`);
}

// --- signature-script pieces --------------------------------------------------------------------------------
/** Push a TokenState record argument as the curve/pool/order entries declare it: template field first, then the
 *  six KCC20State fields, one PushMinimal per leaf (KCC-1 §3.4.6 record lowering). */
export function pushTokenStateV1(b: SigScriptBuilder, tplHash: Uint8Array, s: Kcc20V1State): void {
  assertSpendableKcc20V1State(s);
  b.data(b32('template hash', tplHash)).int(s.amount).data(s.owner).byte(s.ownerScheme).byte(s.borrowScheme).data(s.borrowGuard).data(s.extensionCommitment);
}
/** Push a `KCC20State[]` argument as six grouped columns: amounts8·N ‖ owners32·N ‖ schemes·N ‖ bschemes·N ‖ guards32·N ‖ exts32·N. */
export function pushKcc20V1States(b: SigScriptBuilder, states: Kcc20V1State[]): void {
  if (states.length < 1) throw new Error('transfer requires at least one successor state');
  for (const s of states) assertSpendableKcc20V1State(s);
  b.column(states.map((s) => int8SM(s.amount)));
  b.column(states.map((s) => s.owner));
  b.column(states.map((s) => Uint8Array.of(s.ownerScheme)));
  b.column(states.map((s) => Uint8Array.of(s.borrowScheme)));
  b.column(states.map((s) => s.borrowGuard));
  b.column(states.map((s) => s.extensionCommitment));
}

/** Authority bytes for a holder's piece: 0x00 → sig65; 0x01 → pubkey32 ‖ sig65; 0x04 → empty. */
export function authorityV1(piece: Kcc20V1State, sig65: Uint8Array | null, holderPubkey?: Uint8Array): Uint8Array {
  switch (piece.ownerScheme) {
    case OWNER_SCHEME.COVENANT_ID: return new Uint8Array(0);
    case OWNER_SCHEME.P2PK_SCHNORR: if (!sig65 || sig65.length !== SIG65_LEN) throw new Error('p2pk-schnorr authority needs a 65-byte signature'); return sig65;
    case OWNER_SCHEME.P2PKH_SCHNORR: if (!sig65 || sig65.length !== SIG65_LEN || !holderPubkey) throw new Error('p2pkh-schnorr authority needs the holder pubkey and a 65-byte signature'); return concat([b32('holder pubkey', holderPubkey), sig65]);
    default: throw new Error(`no builder authority form for owner scheme ${piece.ownerScheme}`);
  }
}
/** The leader's witness: path byte 00 ‖ authority (a covenant-owned leader therefore pushes the single byte 00). */
export const leaderWitnessV1 = (authority: Uint8Array): Uint8Array => concat([Uint8Array.of(0x00), authority]);
/** A placeholder signature the wallet replaces (same length, so mass is measured exactly). */
export const SIG65_PLACEHOLDER = new Uint8Array(SIG65_LEN);

/** `transfer` signature script for the LEADER token input: six columns ‖ witness ‖ tag ‖ redeem. */
export function transferSigScriptV1(k: K, tpl: Kcc20V1Template, redeem: Uint8Array, nextStates: Kcc20V1State[], witness: Uint8Array): string {
  if (witness.length < 1) throw new Error('leader witness needs at least the path byte');
  const b = new SigScriptBuilder(k);
  pushKcc20V1States(b, nextStates);
  b.data(witness).data(tpl.tags.transfer).redeem(redeem);
  return b.drain();
}
/** `transfer_delegator` signature script for a DELEGATOR token input: authority ‖ tag ‖ redeem (empty authority → OP_0). */
export function transferDelegatorSigScriptV1(k: K, tpl: Kcc20V1Template, redeem: Uint8Array, authority: Uint8Array): string {
  return new SigScriptBuilder(k).data(authority).data(tpl.tags.transfer_delegator).redeem(redeem).drain();
}
