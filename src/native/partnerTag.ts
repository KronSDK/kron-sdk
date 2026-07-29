// On-chain partner attribution tag — the wallet-integrator program's settlement primitive.
//
// WHY IT LIVES IN THE TRANSACTION. Attribution used to be recorded only by KRON's SEQUENCER, at relay time.
// That coupled "does the partner get paid" to "which submission route did the wallet choose" — and the route
// is chosen for latency and reliability reasons, not accounting ones. With no contention on a token there is
// nothing to sequence, so a sensible integrator submits straight to a node and earned nothing. (Reported by
// KasWare, 2026-07-26. They were right.)
//
// The tag now rides in `tx.payload`, so it is part of the trade itself:
//   • route-independent — sequencer or direct-to-node, the tag is in the transaction either way;
//   • chain-derived — KRON's indexer reads it from the accepted-tx stream, so you can audit your own volume
//     from chain (GET {indexer}/v1/kcc20/attribution?ref=<tag>) instead of trusting KRON's books;
//   • no covenant involvement — none of KRON's covenants read or constrain `payload`, so tagging works on
//     every already-deployed token and needs no new covenant version.
//
// COST. The payload adds 1:1 to serialized size, and transient mass is size×4 normalized by ×0.5 ⇒ ~2 mass
// units per byte. A 32-char tag ≈ 78 mass ≈ 0.000078 KAS at the 100 sompi/gram floor, against a ~0.35 KAS
// network fee on a ~175 KB covenant transaction. Immaterial.
//
// The tag is UNAUTHENTICATED by design — anyone can put any tag in their own transaction. It is a durable,
// publicly auditable claim, not proof of origination; KRON settles by manual review.

/** 2–32 chars: lowercase alphanumerics, '-', '_'. Must match KRON's server-side `REF_RE`. */
export const REF_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** Namespaced so a KRON tag can't be confused with another protocol's payload convention. */
export const TAG_PREFIX = 'kron:r:';
const MAX_TAG_BYTES = TAG_PREFIX.length + 32;

const toHex = (s: string): string => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Partner tag → the hex payload to set on the transaction. Returns `''` for a missing or malformed tag and
 * NEVER throws: an untaggable trade must still be buildable. Note a silently-dropped tag earns nothing, so
 * validate with `REF_RE` at your configuration boundary rather than relying on this to tell you.
 */
export function encodePartnerTag(ref?: string | null): string {
  const r = String(ref ?? '').trim().toLowerCase();
  if (!REF_RE.test(r)) return '';
  return toHex(`${TAG_PREFIX}${r}`);
}

/**
 * Hex payload → the partner tag, or null. Tolerant by design (the payload is attacker-controlled bytes read
 * from chain): anything unparseable, oversized or malformed is simply "no tag". Only an EXACT
 * `kron:r:<valid-ref>` payload attributes — trailing junk is rejected rather than stripped, so a tag can't be
 * smuggled inside an unrelated payload.
 */
export function parsePartnerTag(payloadHex?: string | null): string | null {
  const h = String(payloadHex ?? '');
  if (!h || h.length % 2 !== 0 || h.length > MAX_TAG_BYTES * 2 || !/^[0-9a-fA-F]*$/.test(h)) return null;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  let s: string;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  if (!s.startsWith(TAG_PREFIX)) return null;
  const ref = s.slice(TAG_PREFIX.length);
  return REF_RE.test(ref) ? ref : null;
}
