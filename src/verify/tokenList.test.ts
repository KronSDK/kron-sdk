import { describe, it, expect } from 'vitest';
import { verifyTokenListEntry, kaspaRestFetchTx } from './tokenList.js';
import type { TokenListEntry } from '../client/registryClient.js';

const COVID_A = 'aa'.repeat(32);
const COVID_C = 'cc'.repeat(32);
const TXID = '11'.repeat(32);

const entry = (over: Partial<TokenListEntry> = {}): TokenListEntry => ({
  network: 'testnet-10',
  covenantId: COVID_A,
  symbol: 'GHOST', name: 'Ghost', decimals: 0,
  extensions: {
    curveCovenantId: COVID_C, poolCovenantId: null, genesisTxid: TXID,
    creator: null, creatorPubkey: null, curveParams: null,
    templateVersion: { schema: '39'.repeat(32), silverc: '2c'.repeat(20) }, // covenant version pin (server-stamped)
    graduated: false, chainVerified: true,
  },
  ...over,
});

describe('verifyTokenListEntry', () => {
  it('ok when covid A is present as a covenant_id on a genesis-tx output', async () => {
    const tx = { outputs: [{ covenant_id: COVID_C }, { covenant_id: COVID_A }] };
    const r = await verifyTokenListEntry(entry(), async () => tx);
    expect(r).toEqual({ ok: true, covenantIdPresent: true });
  });

  it('is case-insensitive and accepts the camelCase covenantId field', async () => {
    const tx = { outputs: [{ covenantId: COVID_A.toUpperCase() }] };
    const r = await verifyTokenListEntry(entry(), async () => tx);
    expect(r.ok).toBe(true);
  });

  it('fails when covid A is absent from all outputs', async () => {
    const tx = { outputs: [{ covenant_id: COVID_C }] };
    const r = await verifyTokenListEntry(entry(), async () => tx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found on any output/);
  });

  it('fails (no throw) when the entry has no genesisTxid', async () => {
    const e = entry(); e.extensions.genesisTxid = null;
    const r = await verifyTokenListEntry(e, async () => ({ outputs: [] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/genesisTxid/);
  });

  it('surfaces a fetchTx failure as a reason, not a throw', async () => {
    const r = await verifyTokenListEntry(entry(), async () => { throw new Error('boom'); });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fetchTx failed.*boom/);
  });

  it('tolerates a tx with no outputs array', async () => {
    const r = await verifyTokenListEntry(entry(), async () => ({}) as any);
    expect(r.ok).toBe(false);
  });

  it('is version-independent: a pre-pinning legacy entry (templateVersion null) still verifies', async () => {
    const e = entry(); e.extensions.templateVersion = null;
    const tx = { outputs: [{ covenant_id: COVID_A }] };
    const r = await verifyTokenListEntry(e, async () => tx);
    expect(r.ok).toBe(true);
  });
});

describe('kaspaRestFetchTx', () => {
  it('builds the Kaspa REST URL and strips a trailing slash', async () => {
    let called = '';
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: any) => { called = String(url); return { ok: true, json: async () => ({ outputs: [] }) }; }) as any;
    try {
      await kaspaRestFetchTx('https://api-tn10.kaspa.org/')(TXID);
      expect(called).toBe(`https://api-tn10.kaspa.org/transactions/${TXID}?outputs=true`);
    } finally { globalThis.fetch = orig; }
  });
});
