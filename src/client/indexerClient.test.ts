// `markets()` rows: `tradable` and `poolCovenantId` reach the caller as the indexer serves them, and an indexer from before them
// leaves them absent rather than reading as "no market".
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

  it('leaves tradable undefined on an indexer from before the field', async () => {
    serve([{ tick: 'OLD', graduated: true }]);
    const [row] = await c().markets();
    expect(row!.tradable).toBeUndefined();
    expect(row!.tradable === false).toBe(false);
  });
});
