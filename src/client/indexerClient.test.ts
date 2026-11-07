// `markets()` rows: `tradable` and `poolCovenantId` reach the caller as the indexer serves them, and an indexer from before them
// leaves them absent rather than reading as "no market". The paging options are typed, so `tsc` over this file fails if they go.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { IndexerClient, type MarketRow } from './indexerClient.js';

const serve = (result: unknown[]) => vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ message: 'successful', result }) } as any);
const POOL = 'ab'.repeat(32);

describe('IndexerClient.markets', () => {
  afterEach(() => vi.restoreAllMocks());
  const c = () => new IndexerClient('https://idx.example/v1/kcc20');

  it('asks for the kind and returns each row with its market', async () => {
    const f = serve([{ tick: 'POOLED', tradable: true, poolCovenantId: POOL }, { tick: 'CURVE', tradable: true, poolCovenantId: null }, { tick: 'IMPORT', tradable: false, poolCovenantId: null }]);
    const rows: MarketRow[] = await c().markets({ kind: 'pool' });
    expect(f).toHaveBeenCalledWith('https://idx.example/v1/kcc20/markets?kind=pool');
    expect(rows.map((r) => [r.tick, r.tradable, r.poolCovenantId])).toEqual([['POOLED', true, POOL], ['CURVE', true, null], ['IMPORT', false, null]]);
  });

  it('asks for a page: a bare call is only the first 50 rows the indexer serves', async () => {
    const f = serve([]);
    const url = 'https://idx.example/v1/kcc20/markets';
    await c().markets();
    expect(f).toHaveBeenLastCalledWith(url);
    await c().markets({ limit: 500 });
    expect(f).toHaveBeenLastCalledWith(`${url}?limit=500`);
    await c().markets({ kind: 'curve', offset: 50, limit: 50 });
    expect(f).toHaveBeenLastCalledWith(`${url}?kind=curve&offset=50&limit=50`);
  });

  it('leaves tradable undefined on an indexer from before the field', async () => {
    serve([{ tick: 'OLD', graduated: true }]);
    const [row] = await c().markets();
    expect(row!.tradable).toBeUndefined();
    expect(row!.tradable === false).toBe(false);
  });
});
