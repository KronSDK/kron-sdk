import { describe, it, expect, vi, afterEach } from 'vitest';
import { RegistryClient } from './registryClient.js';

const envelope = {
  name: 'KRON', timestamp: '2026-07-01T00:00:00Z',
  version: { major: 1, minor: 2, patch: 0 }, network: 'testnet-10',
  keywords: ['kron'], tokens: [],
};

describe('RegistryClient.tokenlist', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches the envelope and hits the right URLs (default vs ?all=1)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => envelope } as any);
    const c = new RegistryClient('https://api.example');

    const def = await c.tokenlist();
    expect(def.name).toBe('KRON');
    expect(def.tokens).toEqual([]);
    expect(spy).toHaveBeenLastCalledWith('https://api.example/api/registry/tokenlist');

    await c.tokenlist({ all: true });
    expect(spy).toHaveBeenLastCalledWith('https://api.example/api/registry/tokenlist?all=1');
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as any);
    await expect(new RegistryClient('https://api.example').tokenlist()).rejects.toThrow(/HTTP 503/);
  });
});
