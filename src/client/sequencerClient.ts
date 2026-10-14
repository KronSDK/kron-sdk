// Typed wrapper for KRON's sequencer (docs/INTEGRATION.md §6 in the kron repo). A non-custodial batcher
// that orders signed txs into a valid mempool chain — it never holds keys. Covers BOTH markets:
//   • graduated-pool swaps (`/head` + `/submit`, keyed by the token TICK — not the pool P2SH; the pool's
//     P2SH address moves with its state, the tick is the stable key), and
//   • pre-graduation bonding-curve buys/sells (`/curve/head` + `/curve/submit`, keyed by the curve covid) —
//     the curve is also a single mutable UTXO, so trades chain exactly like pool swaps.
// Direct node submission also works under low contention; the sequencer is a convenience for hot markets.
// `health()` reports which markets the deployed sequencer supports (`markets: ['pool','curve']`).

export type SequencerHead = {
  head: {
    poolOutpoint: { transactionId: string; index: number };
    poolTokenOutpoint: { transactionId: string; index: number };
    reserves: { kasReserve: string; tokenReserve: string; totalShares: string; lpCovid: string | null };
  };
  depth: number;
};

/** `duplicate: true` = a resend of a txid the sequencer already held; `state` is its recorded state and
 *  nothing was re-ordered. `ambiguous: true` = the broadcast outcome is unknown — reconcile with
 *  `status()` / `curveStatus()`, never rebuild. */
export type SubmitResult =
  | { ok: true; txid: string; position: number; duplicate?: boolean; state?: SubmitState }
  | { ok: false; reason: string; retry?: boolean; ambiguous?: boolean; txid?: string };

/** The sequencer's record of a submitted txid (`status()` / `curveStatus()`). */
export type SubmitState = 'broadcasting' | 'accepted' | 'rejected' | 'broadcast-ambiguous' | 'confirmed' | 'dropped' | 'unknown';
export type SubmitStatus = { ok: boolean; known: boolean; state: SubmitState; txid: string };

/** The curve head a client builds a pre-graduation buy/sell against: the curve covenant UTXO
 *  (`poolOutpoint` slot) + the curve-owned token inventory (`poolTokenOutpoint` slot). `head` is null when
 *  no chain is in flight (depth 0) — resolve your own live head from the node/indexer in that case. */
export type CurveSequencerHead = {
  poolOutpoint: { transactionId: string; index: number };
  poolTokenOutpoint: { transactionId: string; index: number };
  reserves: { realKas: string; tokenReserve: string; vKas: string };
};
export type CurveHeadResult =
  | { ok: true; head: CurveSequencerHead | null; depth: number }
  | { ok: false; reason: string };

export class SequencerClient {
  /** @param baseUrl mainnet: 'https://seq.kron.technology' · TN10 staging: 'https://seq.krontest.xyz'.
   *  CORS is deliberately locked to KRON's own site, so an ordinary web page gets a CORS failure, not a
   *  sequencer response. Server-side callers work, as do MV3 extensions that declare
   *  `host_permissions: ["https://seq.kron.technology/*"]` and call from the extension page or service
   *  worker (not a content script). Rate limits are per client IP. */
  constructor(private baseUrl: string) {}

  async health(): Promise<{ ok: boolean; markets?: ('pool' | 'curve')[]; attribution?: boolean }> {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json();
  }

  /** The in-flight head + queue depth for a pool — use this instead of the indexer's confirmed `poolhead`
   *  when the pool is busy, so you build on the latest unconfirmed state.
   *  `tick` is the token TICK (e.g. 'pepe'), NOT the pool P2SH — earlier releases named this parameter
   *  `poolP2sh`, but the deployed sequencer has always keyed pools by tick; a P2SH gets an unknown-pool gate. */
  async head(tick: string): Promise<SequencerHead> {
    const res = await fetch(`${this.baseUrl}/head?pool=${encodeURIComponent(tick)}`);
    if (!res.ok) throw new Error(`sequencer head -> HTTP ${res.status}`);
    return res.json();
  }

  /** Enqueue a signed swap tx built against a `head()` snapshot. A 409-shaped `{ok:false, retry:true}`
   *  means `prevHead` is stale — re-fetch `head()` and rebuild.
   *
   *  `ref` (optional) — your partner tag (kron.technology/wallets): 2–32 chars of `a-z 0-9 - _`,
   *  case-insensitive. A malformed tag is rejected with 400 so a misconfigured integration fails on the
   *  first submit rather than silently at settlement. NOTE: the canonical attribution path is the ON-CHAIN
   *  payload tag (`encodePartnerTag` — UTF-8 `kron:r:<ref>` hex-encoded in `tx.payload`), which is credited
   *  route-independently (sequencer or direct submission); this field is the legacy sequencer-side record. */
  async submit(body: {
    pool: string;
    signedTx: string;
    prevHead: SequencerHead['head'];
    declaredReserves: { kasReserve: string; tokenReserve: string; totalShares: string; lpCovid: string | null };
    ref?: string;
  }): Promise<SubmitResult> {
    const res = await fetch(`${this.baseUrl}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /** The in-flight curve head + queue depth for a pre-graduation token, keyed by its curve covenant id
   *  (hex). `head: null` with `ok: true` means no chain is in flight — the normal state for any idle curve,
   *  and for every curve right after a sequencer restart. It does NOT mean the curve is unknown or untradeable:
   *  build against the node's live curve UTXO and submit HERE anyway (the sequencer adopts that head). Whether
   *  a curve is legitimate is a token-list question (`verifyTokenListEntry`), never a sequencer one.
   *
   *  Fallback policy (what KRON's own web client does):
   *  - sequencer unreachable (this throws / HTTP error), or a definitive submit rejection (malformed,
   *    reserve-mismatch) → build against the node and submit directly; the covenant enforces everything.
   *  - submit `409` with `retry: true` (`stale-head`, `full`) → rebuild on a fresh head, a few times; then
   *    show "market busy" rather than going direct (a direct build would orphan against the in-flight chain).
   *    Make each rebuild share at least one funding input with the attempt it replaces, so at most one lands.
   *  - `ambiguous` or a lost response → never direct, never rebuild: reconcile via `curveStatus()`. */
  async curveHead(curveCovid: string): Promise<CurveHeadResult> {
    const res = await fetch(`${this.baseUrl}/curve/head?covid=${encodeURIComponent(curveCovid)}`);
    if (!res.ok && res.status !== 409) throw new Error(`sequencer curve head -> HTTP ${res.status}`);
    return res.json();
  }

  /** Enqueue a signed pre-graduation buy/sell built against a `curveHead()` snapshot. A 409-shaped
   *  `{ok:false, retry:true}` means `prevHead` is stale — re-fetch `curveHead()` and rebuild.
   *  `ref` — optional partner tag, same contract as `submit()`. */
  async curveSubmit(body: {
    covid: string;
    signedTx: string;
    prevHead: CurveSequencerHead;
    declaredReserves: { realKas: string; tokenReserve: string; vKas: string };
    ref?: string;
  }): Promise<SubmitResult> {
    const res = await fetch(`${this.baseUrl}/curve/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /** The sequencer's view of a submitted tx: `state` is one of `broadcasting`, `accepted`, `rejected`,
   *  `broadcast-ambiguous`, `confirmed`, `dropped` (chain evicted), or `unknown` (never seen / aged out).
   *  On-chain acceptance is the settlement truth; poll this (or subscribe to `events()`) after `submit()`.
   *  `broadcast-ambiguous` means the tx may already be in the mempool — do NOT re-submit a REBUILT tx
   *  (new txid) on a timeout without checking here first, or you can double-spend your own funding inputs. */
  async status(tick: string, txid: string): Promise<SubmitStatus> {
    const res = await fetch(`${this.baseUrl}/status?pool=${encodeURIComponent(tick)}&txid=${encodeURIComponent(txid)}`);
    if (!res.ok) throw new Error(`sequencer status -> HTTP ${res.status}`);
    return res.json();
  }

  /** `status()` for a pre-graduation curve trade, keyed by the curve covenant id (the same key as
   *  `curveHead()` / `curveSubmit()`). Use it to reconcile a `curveSubmit()` whose response was lost or
   *  came back `broadcast-ambiguous`.
   *
   *  The sequencer keeps this state in memory: a restart or age-out turns any txid into `unknown`, so
   *  `unknown` does NOT mean the tx failed — check the chain (node, or `api.kaspa.org/transactions/<txid>`)
   *  before concluding.
   *
   *  Safe retry after a lost response or `broadcast-ambiguous`: re-send the IDENTICAL stored signed tx
   *  string to `curveSubmit()`. The sequencer answers a txid it already holds from its record
   *  (`{ ok: true, duplicate: true, state }`) instead of re-ordering it, and re-broadcasts an ambiguous one.
   *  If the resend comes back `stale-head` / `retry: true` (a sequencer that restarted, or one predating
   *  duplicate handling), that does NOT mean the first copy failed: reconcile with this method and the chain
   *  first. Rebuild only once the original is `rejected` / `dropped`, or absent from the chain after the
   *  head has moved — a rebuilt tx is a second trade. */
  async curveStatus(curveCovid: string, txid: string): Promise<SubmitStatus> {
    const res = await fetch(`${this.baseUrl}/curve/status?covid=${encodeURIComponent(curveCovid)}&txid=${encodeURIComponent(txid)}`);
    if (!res.ok) throw new Error(`sequencer curve status -> HTTP ${res.status}`);
    return res.json();
  }

  /** SSE: head changes for a pool (`tick`, same key as `head()`). Same Node-EventSource caveat as
   *  IndexerClient.stream. */
  events(tick: string, onEvent: (data: unknown) => void, EventSourceImpl?: typeof EventSource): () => void {
    const ES = EventSourceImpl ?? (globalThis as any).EventSource;
    if (!ES) throw new Error('No EventSource available — in Node, pass EventSourceImpl (e.g. from the "eventsource" package)');
    const es = new ES(`${this.baseUrl}/events?pool=${encodeURIComponent(tick)}`);
    es.onmessage = (ev: MessageEvent) => { try { onEvent(JSON.parse(ev.data)); } catch { /* ignore malformed events */ } };
    return () => es.close();
  }
}
