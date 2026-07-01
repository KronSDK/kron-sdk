// Typed wrapper for KRON's pool-swap sequencer (docs/INTEGRATION.md §6 in the kron repo). A non-custodial
// batcher for graduated-pool swaps under contention — it orders signed txs, never holds keys. Pool-only
// (does not cover pre-graduation curve buys). Direct node submission also works for low-contention pools;
// this is purely a convenience for hot pools.

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

export class SequencerClient {
  /** @param baseUrl e.g. 'https://seq.kron.technology' (TN10) */
  constructor(private baseUrl: string) {}

  async health(): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json();
  }

  /** The in-flight head + queue depth for a pool — use this instead of the indexer's confirmed `poolhead`
   *  when the pool is busy, so you build on the latest unconfirmed state. */
  async head(poolP2sh: string): Promise<SequencerHead> {
    const res = await fetch(`${this.baseUrl}/head?pool=${encodeURIComponent(poolP2sh)}`);
    if (!res.ok) throw new Error(`sequencer head -> HTTP ${res.status}`);
    return res.json();
  }

  /** Enqueue a signed swap tx built against a `head()` snapshot. A 409-shaped `{ok:false, retry:true}`
   *  means `prevHead` is stale — re-fetch `head()` and rebuild. */
  async submit(body: {
    pool: string;
    signedTx: string;
    prevHead: SequencerHead['head'];
    declaredReserves: { kasReserve: string; tokenReserve: string; totalShares: string; lpCovid: string | null };
  }): Promise<SubmitResult> {
    const res = await fetch(`${this.baseUrl}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /** SSE: head changes for a pool. Same Node-EventSource caveat as IndexerClient.stream. */
  events(poolP2sh: string, onEvent: (data: unknown) => void, EventSourceImpl?: typeof EventSource): () => void {
    const ES = EventSourceImpl ?? (globalThis as any).EventSource;
    if (!ES) throw new Error('No EventSource available — in Node, pass EventSourceImpl (e.g. from the "eventsource" package)');
    const es = new ES(`${this.baseUrl}/events?pool=${encodeURIComponent(poolP2sh)}`);
    es.onmessage = (ev: MessageEvent) => { try { onEvent(JSON.parse(ev.data)); } catch { /* ignore malformed events */ } };
    return () => es.close();
  }
}
