// Witness-index bounds. `byte[] witnesses` carries ONE byte per entry and the covenant reads each back as a
// script number, so 0x80..0xff decode NEGATIVE (kcc20.sil HLK-L11: "the >= 0 half is load-bearing"). Before
// this guard the SDK silently truncated with `w & 0xff`, producing an unspendable tx with no local error —
// and on a pre-round-2 kcc20 (unguarded `tx.inputs[witnesses[i]]`) the node reports "pick at an invalid
// location", identical to an ABI-arity mismatch but from an unrelated cause.
import { describe, it, expect } from 'vitest';
import { transferSigScript, MAX_WITNESS_IDX, IDENTIFIER } from './kcc20Tx.js';

// transferSigScript needs a Kaspa handle only to build the script; it throws on witness validation before
// touching it, so a null handle is enough to prove the guard fires first.
const noKaspa = null as never;
const redeem = Uint8Array.from([0xaa, 0xbb]);
const state = { ownerIdentifier: new Uint8Array(32), identifierType: IDENTIFIER.COVENANT_ID, amount: 1n, isMinter: false };

const build = (witnesses: number[]) => () => transferSigScript(noKaspa, redeem, [state], witnesses);

describe('witness index bounds', () => {
  it('pins the ceiling at 127, not 255', () => {
    expect(MAX_WITNESS_IDX).toBe(127);
  });

  it('rejects 128 — the first index that decodes negative on-chain', () => {
    expect(build([128])).toThrow(/witnesses\[0\] = 128 is not a usable input index/);
  });

  it('rejects the value that silent truncation used to hide (256 → byte 0)', () => {
    // `256 & 0xff` is 0, which authorizes input 0 — a DIFFERENT input than the caller asked for, and one
    // that on a covenant input carries no signature. This is the case that produced no error at all.
    expect(build([256])).toThrow(/must be an integer in \[0, 127\]/);
  });

  it('rejects negative and non-integer indices', () => {
    expect(build([-1])).toThrow(/not a usable input index/);
    expect(build([1.5])).toThrow(/not a usable input index/);
    expect(build([NaN])).toThrow(/not a usable input index/);
  });

  it('names the offending position so a multi-input build is debuggable', () => {
    expect(build([0, 3, 999])).toThrow(/witnesses\[2\] = 999/);
  });

  it('points the caller at presenceWitnessIdx, the parameter that actually carries this', () => {
    expect(build([200])).toThrow(/presenceWitnessIdx/);
  });

  // In-range values must still reach the script builder — proven by getting PAST validation to the point
  // where the null Kaspa handle is what fails, rather than the guard.
  it('lets every in-range index through to the builder', () => {
    for (const w of [0, 1, 127]) expect(build([w])).not.toThrow(/usable input index/);
  });
});
