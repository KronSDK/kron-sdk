// Typed wrapper for the KCC-20 indexer's REST + SSE surface (docs/INTEGRATION.md §4 in the kron repo).
// Uses the common Kaspa token-indexer response shape ({ message, result }) so existing tooling adapts with
// minimal changes. Amounts are decimal strings in base units (apply `dec` to render); KAS values inside
// `cpState` are sompi unless noted as SCALE units.

export type Envelope<T> = { message: string; result: T };

export type CpState = {
  realKas: number;
  tokenReserve: number;
  graduated: boolean;
  poolTokenReserve?: number;
  poolKas?: number;
  poolTotalShares?: number;
  poolLpCovid?: string;
};

export type TokenInfo = {
  tick: string; name: string; dec: number; max: string; minted: string; holderTotal: number;
  covenantId: string; curveCovenantId: string; poolCovenantId: string | null; graduated: boolean;
  tokenReserve: string; cpState: CpState;
  price?: number; change24h?: number; volume24h?: number; volumeTotal?: number;
  trades24h?: number; tradesTotal?: number; tvl?: number; reserveKas?: string;
};

export type Balance = { tick: string; balance: string; dec: number };
export type TokenUtxo = {
  outpoint: { transactionId: string; index: number };
  amount: string;
  scriptPublicKey: string;
  redeemScriptHex: string;
  ownerAddress: string;
};
export type PoolHead = {
  pool: { transactionId: string; index: number };
  poolToken: { transactionId: string; index: number };
  reserves: { kasReserve: string; tokenReserve: string; totalShares: string; lpCovid: string | null };
};
export type LpUtxo = { outpoint: { transactionId: string; index: number }; amount: string };
export type LpEarnings = { tick: string; address: string; earnedKas: string };
export type IndexerInfo = { tokenTotal: number; daaScore: number; synced: boolean; network: string };
export type Trade = Record<string, unknown>;
export type Holder = { address: string; balance: string };
export type Ohlc = { t: number; o: number; h: number; l: number; c: number; v: number };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body: Envelope<T> = await res.json();
  return body.result;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

export class IndexerClient {
  /** @param baseUrl e.g. 'https://idx.kron.technology/v1/kcc20' (TN10) — no default baked in; pass the
   *  network-appropriate URL explicitly (mainnet endpoints publish separately at launch). */
  constructor(private baseUrl: string) {}

  info(): Promise<IndexerInfo> { return fetchJson(`${this.baseUrl}/info`); }
  markets(opts: { kind?: 'curve' | 'pool' } = {}): Promise<TokenInfo[]> { return fetchJson(`${this.baseUrl}/markets${qs(opts)}`); }
  topTraders(): Promise<unknown[]> { return fetchJson(`${this.baseUrl}/top-traders`); }

  token(tick: string): Promise<TokenInfo> { return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}`); }
  balance(tick: string, address: string): Promise<Balance> {
    return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}/address/${encodeURIComponent(address)}`);
  }
  tokenlist(address: string): Promise<Balance[]> { return fetchJson(`${this.baseUrl}/address/${encodeURIComponent(address)}/tokenlist`); }
  tokenUtxos(tick: string, address: string): Promise<TokenUtxo[]> {
    return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}/address/${encodeURIComponent(address)}/utxos`);
  }

  holders(tick: string): Promise<Holder[]> { return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}/holders`); }
  trades(tick: string, opts: { offset?: number; limit?: number } = {}): Promise<Trade[]> {
    return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}/trades${qs(opts)}`);
  }
  ohlc(tick: string, opts: { interval: string; from?: number; to?: number }): Promise<Ohlc[]> {
    return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}/ohlc${qs(opts)}`);
  }
  addressTrades(address: string): Promise<Trade[]> { return fetchJson(`${this.baseUrl}/address/${encodeURIComponent(address)}/trades`); }

  poolhead(tick: string): Promise<PoolHead> { return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}/poolhead`); }

  lpUtxos(tick: string, address: string): Promise<LpUtxo[]> {
    return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}/lp/${encodeURIComponent(address)}/utxos`);
  }
  lpEarnings(tick: string, address: string): Promise<LpEarnings> {
    return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}/lp/${encodeURIComponent(address)}/earnings`);
  }

  /**
   * Subscribe to the SSE update stream (all tokens, or one if `tick` is given). Returns an unsubscribe
   * function. Browser: uses the native EventSource. Node: pass an EventSource-compatible constructor (e.g.
   * the `eventsource` npm package) via `EventSourceImpl` — Node has no built-in EventSource on most
   * supported versions.
   */
  stream(onUpdate: (data: unknown) => void, opts: { tick?: string; EventSourceImpl?: typeof EventSource } = {}): () => void {
    const ES = opts.EventSourceImpl ?? (globalThis as any).EventSource;
    if (!ES) throw new Error('No EventSource available — in Node, pass EventSourceImpl (e.g. from the "eventsource" package)');
    const es = new ES(`${this.baseUrl}/stream${qs({ tick: opts.tick })}`);
    es.addEventListener('update', (ev: MessageEvent) => {
      try { onUpdate(JSON.parse(ev.data)); } catch { /* ignore malformed events */ }
    });
    return () => es.close();
  }
}
