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
};

export type VerifySignatureResult = {
  ok: boolean;
  /** Whether the document carried a signature at all (false ⇒ unsigned backend, not a forgery). */
  signed: boolean;
  /** Which key was checked: the caller's pinned key, or trust-on-first-use of the response's. */
  keySource?: 'pinned' | 'response';
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
 *  Key policy (mirrors KRON's pool-manifest verifier): a `pinnedPublicKey` you obtained out-of-band
 *  always wins — if the response names a different key, that's a `signer mismatch` failure. With no
 *  pin, the response's own key is used (trust-on-first-use) and reported as `keySource:'response'`
 *  so you can apply your own policy.
 *
 *  `expectedVariant` defaults to the curated default list `{all:false, tier:null}` — pass the
 *  variant you actually requested. A signed document whose bound variant differs (or is missing)
 *  fails: that's the anti-replay check. */
export function verifyTokenListSignature(
  kaspa: KaspaMessageVerifier,
  list: SignedTokenList,
  opts: { pinnedPublicKey?: string; expectedVariant?: Partial<TokenListVariant> } = {},
): VerifySignatureResult {
  if (!list?.signature) return { ok: false, signed: false, reason: 'list is unsigned (older backend or signing key not configured)' };

  const pinned = xOnly(opts.pinnedPublicKey);
  const fromResponse = xOnly(list.publicKey);
  let keySource: 'pinned' | 'response';
  let publicKey: string;
  if (pinned) {
    if (fromResponse && fromResponse !== pinned) {
      return { ok: false, signed: true, keySource: 'pinned', reason: `signer mismatch: response publicKey ${fromResponse} != pinned ${pinned}` };
    }
    keySource = 'pinned'; publicKey = pinned;
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
  return valid
    ? { ok: true, signed: true, keySource }
    : { ok: false, signed: true, keySource, reason: 'signature verification failed (document was modified, or signed by a different key)' };
}
