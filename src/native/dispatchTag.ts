// KCC-1 §3.5 dispatch tags for the kcc20v1 family (docs/kcc20v1/PLAN.md §5 "Web and SDK"). A SilverScript v1.0.0
// entry is selected by the first four bytes of BLAKE3 over its canonical signature `name(types)` (records as `{…}`
// with field names omitted), pushed as a 4-byte data push right before the redeem — there is no positional selector.
// The builders take each entry's tag from the compiled artifact (`entries.<fn>.dispatch_tag`); this module derives
// the same tags from the signatures so the gates can prove the two agree and the builders can refuse a template
// whose ABI changed under them. Pure; no SDK.
import { blake3 } from '@noble/hashes/blake3.js';

const te = new TextEncoder();
export const hexOf = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
export const bytesOfHex = (h: string): Uint8Array => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));

/** blake3(signature)[0..4] — KCC-1 §3.5.1. */
export const dispatchTagV1 = (signature: string): Uint8Array => blake3(te.encode(signature)).slice(0, 4);

/** The reference token's KCC20State as a dispatch type name, and the family's record types. */
export const TOKEN_STATE_TYPE = '{int,byte[32],byte,byte,byte[32],byte[32]}';          // KCC20State (the token's own entries)
export const TOKEN_STATE_ARG_TYPE = '{byte[32],int,byte[32],byte,byte,byte[32],byte[32]}'; // TokenState as the curve/pool/order see it (template field first)
export const POOL_STATE_TYPE = '{int,int,byte[32],int,byte[32]}';
export const ORDER_STATE_TYPE = '{byte[32],byte[32],byte[32],int,int}';

/** Canonical entry signatures of the family programs (must track covenants/kcc20v1/*.sil). */
export const FAMILY_SIGNATURES = {
  token: {
    transfer: `transfer(${TOKEN_STATE_TYPE}[],byte[])`,
    transfer_delegator: 'transfer_delegator(byte[])',
  },
  curve: {
    init: `init(int,${TOKEN_STATE_ARG_TYPE},${TOKEN_STATE_ARG_TYPE},byte[],byte[])`,
    buy: `buy(int,int,${TOKEN_STATE_ARG_TYPE},${TOKEN_STATE_ARG_TYPE},int,byte[32])`,
    sell: `sell(int,int,${TOKEN_STATE_ARG_TYPE},${TOKEN_STATE_ARG_TYPE},int,byte[32])`,
    graduate: `graduate(${POOL_STATE_TYPE},${TOKEN_STATE_ARG_TYPE},byte[],byte[])`,
    batchBuy: `batchBuy(int,${TOKEN_STATE_ARG_TYPE})`,
  },
  pool: {
    swapKasForToken: `swapKasForToken(int,int,${TOKEN_STATE_ARG_TYPE},${TOKEN_STATE_ARG_TYPE},int,byte[32])`,
    swapTokenForKas: `swapTokenForKas(int,${TOKEN_STATE_ARG_TYPE},${TOKEN_STATE_ARG_TYPE},int,byte[32])`,
    addLiquidity: `addLiquidity(int,int,int,${TOKEN_STATE_ARG_TYPE},${TOKEN_STATE_ARG_TYPE},${TOKEN_STATE_ARG_TYPE},int,byte[32])`,
    removeLiquidity: `removeLiquidity(int,int,int,${TOKEN_STATE_ARG_TYPE},${TOKEN_STATE_ARG_TYPE},${TOKEN_STATE_ARG_TYPE},int,byte[32])`,
    bindLp: `bindLp(${TOKEN_STATE_ARG_TYPE},byte[],byte[])`,
  },
  order: {
    settle: `settle(${TOKEN_STATE_ARG_TYPE})`,
    refund: 'refund(int)',
  },
} as const;

export type FamilyProgram = keyof typeof FAMILY_SIGNATURES;

/** Derived tags (hex) for one program's entries. */
export function familyTagsV1(program: FamilyProgram): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [entry, sig] of Object.entries(FAMILY_SIGNATURES[program])) out[entry] = hexOf(dispatchTagV1(sig));
  return out;
}

/** The reference token's published tags (covenants/kcc20v1/toolchain.json kcc20Reference.dispatchTags). */
export const TOKEN_DISPATCH_TAGS = { transfer: '79c71c23', transfer_delegator: 'fd3ef14a' } as const;

/** Refuse a template whose compiled tags disagree with the signatures this code encodes arguments for. */
export function assertFamilyTagsV1(program: FamilyProgram, compiledTags: Record<string, string | Uint8Array>): Record<string, Uint8Array> {
  const want = familyTagsV1(program);
  const out: Record<string, Uint8Array> = {};
  for (const [entry, tagHex] of Object.entries(want)) {
    const got = compiledTags[entry];
    const gotHex = got == null ? '' : typeof got === 'string' ? got.replace(/^0x/, '').toLowerCase() : hexOf(got);
    if (gotHex !== tagHex) throw new Error(`${program}.${entry}: compiled dispatch tag ${gotHex || '(missing)'} != ${tagHex} derived from ${FAMILY_SIGNATURES[program][entry as keyof typeof FAMILY_SIGNATURES[typeof program]]} — the covenant ABI changed under this builder`);
    out[entry] = bytesOfHex(tagHex);
  }
  return out;
}
