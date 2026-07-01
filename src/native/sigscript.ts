// SilverScript signature-script argument ABI — a faithful TS port of the compiler's `build_sig_script`. A
// covenant is spent with a P2SH input whose signature script is:
//   <encoded entrypoint args...> [<selector>] <redeemScript>
// This module encodes the entrypoint args exactly as the compiler does, so the bytes the VM sees match what
// `silverc` would build.
//
// The encoding rules (from build_sig_script / push_typed_sigscript_arg / encode_array_literal):
//  • Scalar arg / single-struct field — pushed individually (push_sigscript_arg):
//      int  → addI64 (minimal CScriptNum)      bool → addI64(0|1)
//      byte → addData([b])                      byte[N]/pubkey/sig → addData(raw bytes)
//      A STRUCT arg pushes each field in declared order using these scalar rules.
//  • Struct-array arg (e.g. kcc20 `transfer`'s `State[]`) — COLUMN-MAJOR: for each struct field, the
//    field's value across all elements is gathered into a dynamic array and pushed as ONE item, using the
//    FIXED-WIDTH element encoding (encode_fixed_size_value): int → 8-byte LE, bool → 1 byte, byte → 1 byte,
//    byte[N] → N raw bytes. (Note the asymmetry: a scalar int field uses minimal addI64, but an int inside
//    an array column is fixed 8-byte LE.)
//  • Plain dynamic arrays — byte[] → addData(bytes); int[]/bool[]/sig[] → fixed-width-concat → addData.
//  • Selector — the entrypoint's branch index (declaration order among entrypoints) is appended via addI64,
//    UNLESS the contract has a single entrypoint (then it is omitted).
//
// No top-level SDK import (only `import type`) — the caller passes the loaded WASM namespace `k`, so this
// runs unchanged in the browser and under Node.
import type { Kaspa } from '../wasm/kaspa.types.js';

type K = Kaspa;

/** 8-byte little-endian encoding of a non-negative int (encode_fixed_size_value for `int`, width 8). */
export function int8LE(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/**
 * A SilverScript ScriptBuilder wrapper that records pushes in the compiler's order, then drains to hex.
 * Use the scalar push helpers for struct fields / scalar args and the column helpers for struct arrays,
 * then `selector()` (if multi-entrypoint) and `redeem()` last (the standard P2SH spend layout).
 */
export class SigScriptBuilder {
  sb: any;
  constructor(k: K) {
    this.sb = new (k as any).ScriptBuilder({ flags: { covenantsEnabled: true } });
  }
  /** int scalar (minimal CScriptNum). */
  int(v: bigint): this {
    this.sb.addI64(v);
    return this;
  }
  /** bool scalar → 1|0 via addI64 (matches push_sigscript_arg Bool). */
  bool(b: boolean): this {
    this.sb.addI64(b ? 1n : 0n);
    return this;
  }
  /** single byte → addData([b]). */
  byte(b: number): this {
    this.sb.addData(Uint8Array.of(b & 0xff));
    return this;
  }
  /** raw bytes (byte[N], pubkey, sig, byte[]) → addData. */
  data(bytes: Uint8Array): this {
    this.sb.addData(bytes);
    return this;
  }
  /** a column of N values pushed as one fixed-width-concatenated array item (encode_array_literal). */
  column(items: Uint8Array[]): this {
    this.sb.addData(concat(items));
    return this;
  }
  /** the entrypoint selector (branch index). Omit for single-entrypoint contracts. */
  selector(index: number): this {
    this.sb.addI64(BigInt(index));
    return this;
  }
  /** the P2SH redeem script (pushed last; the VM pops it, hash-checks, then runs it on the arg stack). */
  redeem(script: Uint8Array): this {
    this.sb.addData(script);
    return this;
  }
  /** finalize → signature-script hex. */
  drain(): string {
    return this.sb.drain();
  }
}
