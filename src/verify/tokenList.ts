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
import type { TokenListEntry } from '../client/registryClient.js';

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
