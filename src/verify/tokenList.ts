// Verify a token-list entry against the chain. The token list (RegistryClient.tokenlist) is self-verifiable
// by design: each entry carries its covenantId (covid A) + a genesisTxid proof pointer, so a consumer can
// confirm the token is a genuine on-chain covenant and not a registry spoof — WITHOUT trusting KRON's
// backend. This is the anti-phishing check every wallet/explorer/aggregator should run before listing an
// entry.
//
// The check: fetch the entry's genesis tx and confirm its covenantId appears as a `covenant_id` on one of
// the tx's outputs (that is exactly where a KIP-20 covenant is created — proven against api-tn10). A forged
// entry claiming a covenantId that isn't on its declared genesis tx fails.
//
// `fetchTx` is INJECTED: this SDK ships no Kaspa node/REST client (its own clients only talk to KRON's
// backend/indexer). Use `kaspaRestFetchTx(baseUrl)` for the common Kaspa REST shape, or pass your own
// (node RPC, a proxy, a fixture). NOTE: this does not re-derive the curve P2SH from params — the SDK has no
// covenant compiler. For a full cryptographic re-derivation, feed the init tx's outpoint + authorized
// outputs to `genesis.genesisCovenantId` (see src/native/genesis.ts).
//
// TEMPLATE PINNING (KRON ROADMAP 3.5): entries carry `extensions.templateVersion` — the covenant version the
// token was deployed under. An external auditor recompiling the covenant templates from
// `extensions.curveParams` must compile THAT version's `.sil` source set (archived at
// `covenants/versions/<schema[0..12]>/` in the kron repo), not the newest sources — a later covenant change
// legitimately produces different bytes for new tokens. THIS verifier is version-independent (it checks the
// consensus-assigned covenantId against the genesis tx), so it needs no source set at all.
//
// LIST-LEVEL SIGNATURE (additive, backend ≥ 2026-07-27): when KRON's platform key is configured the
// tokenlist envelope also carries `variant`/`signature`/`publicKey` root fields — a Schnorr message
// signature over `canonicalTokenListMsg`. It authenticates the list *metadata* (names, logos) against
// tampering between KRON and you (a hostile mirror, a CDN layer, a modified saved copy); it does NOT
// replace the per-entry chain check above, and it does not protect against a compromise of KRON's own
// backend (the key lives there). Verify with `verifyTokenListSignature` below.
//
// FRESHNESS (backend ≥ 2026-09): the envelope also carries `seq`/`signedAt`/`ttlSeconds` and a second
// signature `signatureV2` over `canonicalTokenListMsgV2`, which binds those three fields. v1 alone has no
// timestamp, so a months-old genuinely-signed list (a delisted token, a reverted logo) still verifies. The
// verifier checks `signatureV2` whenever it is present; pass `requireFresh: true` to also reject a document
// with no v2 signature (an attacker can strip it) or one past `signedAt + ttlSeconds`.
import type { TokenList, TokenListEntry } from '../client/registryClient.js';

/** Minimal shape of a fetched Kaspa transaction — only what the verifier reads. `covenant_id` is the
 *  Kaspa REST field; `covenantId` is accepted too for node/proxy shapes that camel-case it. */
export type FetchedTx = { outputs?: Array<{ covenant_id?: string | null; covenantId?: string | null } | null> };
export type FetchTx = (txid: string) => Promise<FetchedTx>;

export type VerifyResult = { ok: boolean; covenantIdPresent: boolean; reason?: string };

const lc = (s?: string | null): string => String(s ?? '').toLowerCase();

/** Verify a single token-list entry against the chain via an injected tx fetcher. Never throws — a fetch
 *  failure or a missing field is returned as `{ ok: false, reason }` so callers can filter a whole list. */
export async function verifyTokenListEntry(entry: TokenListEntry, fetchTx: FetchTx): Promise<VerifyResult> {
  const covid = lc(entry?.covenantId);
  const txid = entry?.extensions?.genesisTxid ?? null;
  if (!covid) return { ok: false, covenantIdPresent: false, reason: 'entry has no covenantId' };
  if (!txid) return { ok: false, covenantIdPresent: false, reason: 'entry has no genesisTxid to verify against' };

  let tx: FetchedTx;
  try {
    tx = await fetchTx(txid);
  } catch (e: any) {
    return { ok: false, covenantIdPresent: false, reason: `fetchTx failed for ${txid}: ${e?.message ?? e}` };
  }

  const outs = Array.isArray(tx?.outputs) ? tx.outputs : [];
  const present = outs.some((o) => lc(o?.covenant_id ?? o?.covenantId) === covid);
  return present
    ? { ok: true, covenantIdPresent: true }
    : { ok: false, covenantIdPresent: false, reason: `covenantId ${entry.covenantId} not found on any output of genesis tx ${txid}` };
}

/** A `fetchTx` for the common Kaspa REST shape: `GET {baseUrl}/transactions/{txid}?outputs=true`. Uses the
 *  global `fetch` (Node ≥20 / browsers). Pass your own fetcher instead for a node RPC or a proxy. */
export function kaspaRestFetchTx(baseUrl: string): FetchTx {
  const base = baseUrl.replace(/\/+$/, '');
  return async (txid: string): Promise<FetchedTx> => {
    const res = await fetch(`${base}/transactions/${encodeURIComponent(txid)}?outputs=true`);
    if (!res.ok) throw new Error(`kaspa REST tx ${txid} -> HTTP ${res.status}`);
    return (await res.json()) as FetchedTx;
  };
}

// --- list-level platform signature ---------------------------------------------------------------

/** The query variant a signed list covers — `{all:false, tier:null}` is the default curated list. */
export type TokenListVariant = { all: boolean; tier: string | null };

/** A token list as served by a signing-enabled backend. All three fields absent = unsigned (older
 *  backend or key not configured) — `verifyTokenListSignature` reports that as `signed:false`. */
export type SignedTokenList = TokenList & {
  variant?: TokenListVariant;
  signature?: string;
  publicKey?: string;
  /** Monotonic freshness counter (the epoch second the document was signed). */
  seq?: number;
  /** Epoch seconds the document was signed. */
  signedAt?: number;
  /** How long after `signedAt` the document should be treated as current. */
  ttlSeconds?: number;
  /** Signature over `canonicalTokenListMsgV2` — v1 plus `seq`/`signedAt`/`ttlSeconds`. */
  signatureV2?: string;
};

/** KRON's mainnet token-list signing key (x-only Schnorr). Published here so the key a consumer pins does
 *  not come from the same server as the document it authenticates. `verifyTokenListSignature` uses it by
 *  default for `network: 'mainnet'` lists. The same key signs KRON's pool manifest; if it is ever rotated,
 *  a new SDK release ships the new key and the change is announced in CHANGELOG.md. */
export const KRON_TOKENLIST_PUBLIC_KEY = 'f0ff44a11b3f315703b1dced26a2197b4c9869834c791a1e9131df2f6652a3be';

export type VerifySignatureResult = {
  ok: boolean;
  /** Whether the document carried a signature at all (false ⇒ unsigned backend, not a forgery). */
  signed: boolean;
  /** Which key was checked: the caller's pinned key, the SDK's built-in mainnet key
   *  (`KRON_TOKENLIST_PUBLIC_KEY`), or trust-on-first-use of the response's own key. */
  keySource?: 'pinned' | 'builtin' | 'response';
  /** Present when the document carried a valid `signatureV2`: whether `now ≤ signedAt + ttlSeconds`. */
  fresh?: boolean;
  /** The document's `seq`, when `signatureV2` verified — store it and pass it back as `minSeq` next time. */
  seq?: number;
  reason?: string;
};

/** The Schnorr `verifyMessage` surface of the kaspa WASM module — pass `await loadKaspa()` from
 *  `@kronsdk/kron-sdk/wasm` (injected so this module stays WASM-free and unit-testable offline). */
export type KaspaMessageVerifier = {
  verifyMessage(args: { message: string; signature: string; publicKey: string }): boolean;
};

/** Canonical signed message. MUST remain byte-identical to `backend/tokenListSignature.mjs` in the
 *  kron repo (guarded by scripts/verify-parity.mjs at publish time and by kron's frontend-security
 *  suite). Excludes the volatile per-request `timestamp`; includes the query `variant` so a signed
 *  `?all=1` document can't be replayed as the curated default list. Serialize the document exactly
 *  as parsed from the wire — re-sorting keys breaks the signature. */
export const canonicalTokenListMsg = (doc: SignedTokenList): string => JSON.stringify({
  v: 'KRON-TOKENLIST-1',
  network: lc(doc.network),
  variant: { all: !!doc.variant?.all, tier: doc.variant?.tier ?? null },
  version: { major: Number(doc.version?.major ?? 0), minor: Number(doc.version?.minor ?? 0), patch: Number(doc.version?.patch ?? 0) },
  tokens: doc.tokens ?? [],
});

/** Canonical v2 message — v1 plus the freshness binding. Same byte contract as v1 with
 *  `canonicalTokenListMsgV2` in `backend/tokenListSignature.mjs`. */
export const canonicalTokenListMsgV2 = (doc: SignedTokenList): string => JSON.stringify({
  v: 'KRON-TOKENLIST-2',
  network: lc(doc.network),
  variant: { all: !!doc.variant?.all, tier: doc.variant?.tier ?? null },
  version: { major: Number(doc.version?.major ?? 0), minor: Number(doc.version?.minor ?? 0), patch: Number(doc.version?.patch ?? 0) },
  seq: Number(doc.seq ?? 0),
  signedAt: Number(doc.signedAt ?? 0),
  ttlSeconds: Number(doc.ttlSeconds ?? 0),
  tokens: doc.tokens ?? [],
});

/** Normalize a pubkey to lowercase x-only hex: strips 0x, a 02/03 compressed prefix, or extracts X
 *  from an uncompressed 04-key (same tolerances as the wallet adapter's getXOnlyPublicKey). */
const xOnly = (key?: string | null): string => {
  let h = lc(key).replace(/^0x/, '');
  if (h.length === 66 && (h.startsWith('02') || h.startsWith('03'))) h = h.slice(2);
  else if (h.length === 130 && h.startsWith('04')) h = h.slice(2, 66);
  return h;
};

/** Verify a token list's platform signature. Never throws — every failure mode is a `reason`.
 *
 *  Key policy (mirrors KRON's pool-manifest verifier): the expected key always wins — if the response
 *  names a different key, that's a `signer mismatch` failure. The expected key is, in order:
 *  `pinnedPublicKey` if you pass one; else `KRON_TOKENLIST_PUBLIC_KEY` for a `network: 'mainnet'` list;
 *  else (a testnet list, or `trustResponseKey: true` for a self-hosted backend) the response's own key,
 *  reported as `keySource:'response'` — trust-on-first-use, which proves nothing on its own.
 *
 *  `expectedVariant` defaults to the curated default list `{all:false, tier:null}` — pass the
 *  variant you actually requested. A signed document whose bound variant differs (or is missing)
 *  fails: that's the anti-replay check.
 *
 *  Freshness: a present `signatureV2` is always verified (an invalid one fails the document) and sets
 *  `fresh`/`seq` on the result. `requireFresh: true` additionally fails a document with no v2 signature
 *  or one that has expired; `minSeq` fails a document older than one you already hold (rollback). */
export function verifyTokenListSignature(
  kaspa: KaspaMessageVerifier,
  list: SignedTokenList,
  opts: {
    pinnedPublicKey?: string;
    trustResponseKey?: boolean;
    expectedVariant?: Partial<TokenListVariant>;
    requireFresh?: boolean;
    minSeq?: number;
    /** Clock override, epoch ms (tests). */
    now?: number;
  } = {},
): VerifySignatureResult {
  if (!list?.signature) return { ok: false, signed: false, reason: 'list is unsigned (older backend or signing key not configured)' };

  const builtin = !opts.trustResponseKey && lc(list.network) === 'mainnet' ? KRON_TOKENLIST_PUBLIC_KEY : '';
  const pinned = xOnly(opts.pinnedPublicKey) || builtin;
  const pinSource: 'pinned' | 'builtin' = opts.pinnedPublicKey ? 'pinned' : 'builtin';
  const fromResponse = xOnly(list.publicKey);
  let keySource: 'pinned' | 'builtin' | 'response';
  let publicKey: string;
  if (pinned) {
    if (fromResponse && fromResponse !== pinned) {
      return { ok: false, signed: true, keySource: pinSource, reason: `signer mismatch: response publicKey ${fromResponse} != ${pinSource} ${pinned}` };
    }
    keySource = pinSource; publicKey = pinned;
  } else if (fromResponse) {
    keySource = 'response'; publicKey = fromResponse;
  } else {
    return { ok: false, signed: true, reason: 'signed list carries no publicKey and no pinnedPublicKey was provided' };
  }

  if (!list.variant) return { ok: false, signed: true, keySource, reason: 'signed list has no variant field (cannot rule out cross-variant replay)' };
  const expected: TokenListVariant = { all: false, tier: null, ...opts.expectedVariant };
  const got: TokenListVariant = { all: !!list.variant.all, tier: list.variant.tier ?? null };
  if (got.all !== expected.all || got.tier !== expected.tier) {
    return { ok: false, signed: true, keySource, reason: `variant mismatch: document is signed for ${JSON.stringify(got)} but ${JSON.stringify(expected)} was expected (possible replay)` };
  }

  let valid = false;
  try {
    valid = kaspa.verifyMessage({ message: canonicalTokenListMsg(list), signature: String(list.signature), publicKey }) === true;
  } catch (e: any) {
    return { ok: false, signed: true, keySource, reason: `verifyMessage failed: ${e?.message ?? e}` };
  }
  if (!valid) return { ok: false, signed: true, keySource, reason: 'signature verification failed (document was modified, or signed by a different key)' };

  if (!list.signatureV2) {
    return opts.requireFresh
      ? { ok: false, signed: true, keySource, reason: 'requireFresh: document has no signatureV2 (older backend, or the freshness signature was stripped)' }
      : { ok: true, signed: true, keySource };
  }
  let validV2 = false;
  try {
    validV2 = kaspa.verifyMessage({ message: canonicalTokenListMsgV2(list), signature: String(list.signatureV2), publicKey }) === true;
  } catch (e: any) {
    return { ok: false, signed: true, keySource, reason: `verifyMessage (v2) failed: ${e?.message ?? e}` };
  }
  if (!validV2) return { ok: false, signed: true, keySource, reason: 'signatureV2 verification failed (seq/signedAt/ttlSeconds were modified)' };

  const seq = Number(list.seq ?? 0);
  const expiresAtMs = (Number(list.signedAt ?? 0) + Number(list.ttlSeconds ?? 0)) * 1000;
  const fresh = (opts.now ?? Date.now()) <= expiresAtMs;
  if (opts.minSeq != null && seq < opts.minSeq) {
    return { ok: false, signed: true, keySource, fresh, seq, reason: `rollback: document seq ${seq} is older than minSeq ${opts.minSeq}` };
  }
  if (opts.requireFresh && !fresh) {
    return { ok: false, signed: true, keySource, fresh, seq, reason: `requireFresh: document expired at ${new Date(expiresAtMs).toISOString()}` };
  }
  return { ok: true, signed: true, keySource, fresh, seq };
}
