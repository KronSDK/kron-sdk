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

export type SubmitResult =
  | { ok: true; txid: string; position: number }
  | { ok: false; reason: string; retry: boolean };

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
  /** @param baseUrl e.g. 'https://seq.kron.technology' (TN10) */
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
   *  (hex). `head: null` with `ok: true` means no chain is in flight — build against the confirmed state
   *  from the node/indexer instead. A `{ok:false}` gate (unknown/full/unreachable) → submit direct. */
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
  async status(tick: string, txid: string): Promise<{ ok: boolean; known: boolean; state: string; txid: string }> {
    const res = await fetch(`${this.baseUrl}/status?pool=${encodeURIComponent(tick)}&txid=${encodeURIComponent(txid)}`);
    if (!res.ok) throw new Error(`sequencer status -> HTTP ${res.status}`);
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
