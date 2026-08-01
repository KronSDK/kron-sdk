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
  /** LP-BIND INTEGRITY. Pools on the pre-`e5469a7ad482` pool covenant (the tokens graduated before the
   *  counterfeit-LP guard landed) run a `bindLp` that lacks `require(OpCovInputCount(boundLp)==0)`, so a
   *  permissionless binder can pass off a pre-minted token as the pool's LP shares and keep the remainder as
   *  counterfeit shares that drain exactly the voluntary liquidity a depositor adds. The covenant is permanently
   *  pinned and cannot be patched for those tokens. The indexer therefore reports whether the pool's L-share
   *  supply matches the honest invariant (`MAX_SHARES − lockedShares`): `true` = safe to provide liquidity;
   *  `false` = a counterfeit bind, DO NOT add liquidity; `undefined`/`null` = not computable yet (older indexer
   *  or L not tracked) — treat as UNVERIFIED and do not add liquidity. **Always gate `poolCp.buildAddLiquidity`
   *  on this** (see `IndexerClient.assertLpBindSafe`). Removing liquidity is always safe and is not gated. */
  lpBindVerified?: boolean | null;
  /** Total on-chain supply of the pool's LP-share token (decimal string); the basis for `lpBindVerified`. */
  lpSupply?: string;
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
  addressTrades(address: string, opts: { offset?: number; limit?: number } = {}): Promise<Trade[]> {
    return fetchJson(`${this.baseUrl}/address/${encodeURIComponent(address)}/trades${qs(opts)}`);
  }
  /** One address's trade history on ONE token (a wallet's per-token history view). */
  tokenAddressTrades(tick: string, address: string, opts: { offset?: number; limit?: number } = {}): Promise<Trade[]> {
    return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}/address/${encodeURIComponent(address)}/trades${qs(opts)}`);
  }

  poolhead(tick: string): Promise<PoolHead> { return fetchJson(`${this.baseUrl}/token/${encodeURIComponent(tick)}/poolhead`); }

  /** LP-bind integrity for `tick`'s pool: `true` safe, `false` counterfeit, `null` not-yet-verifiable. See
   *  `CpState.lpBindVerified`. Returns `null` (fail-safe) when the field is absent (indexer predates it). */
  async lpBindVerified(tick: string): Promise<boolean | null> {
    // `/token/{tick}` returns `result` as a single-element ARRAY (the KRC-20-shaped envelope), which fetchJson
    // passes through verbatim — tolerate both an array and a bare object so this stays correct either way.
    const info = (await this.token(tick)) as unknown as TokenInfo | TokenInfo[];
    const row = Array.isArray(info) ? info[0] : info;
    const v = row?.cpState?.lpBindVerified;
    return v === true ? true : v === false ? false : null;
  }
  /** MANDATORY gate before `poolCp.buildAddLiquidity`: throws unless the pool's LP shares are provably honest.
   *  A pre-`e5469a7ad482` pool can be counterfeit-bound so that added liquidity is drained by counterfeit shares;
   *  only an exact L-supply match clears it. Fail-safe: an unverifiable (`null`) pool also throws. Removing
   *  liquidity does not need this. */
  async assertLpBindSafe(tick: string): Promise<void> {
    const v = await this.lpBindVerified(tick);
    if (v !== true) {
      throw new Error(v === false
        ? `Refusing to add liquidity to ${tick}: the pool's LP shares failed an on-chain integrity check (its bindLp was not a genuine genesis — counterfeit shares could drain your deposit).`
        : `Refusing to add liquidity to ${tick}: the pool's LP-share integrity is not confirmed yet (retry shortly).`);
    }
  }

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
