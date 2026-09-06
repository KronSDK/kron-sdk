// shapeCpTemplates — the ONE mapping from the cp-template response's params echo onto the builders'
// dual-ABI discriminators. A missed or inverted flag here silently builds the wrong ABI (rejected by every
// new-schema token, or arg-stack-corrupting on a legacy one), so the mapping is pinned by test.
import { describe, it, expect, vi } from 'vitest';
import { shapeCpTemplates, fetchCpTemplates, type CpTemplatesResponse } from './templates.js';

const baseParams = {
  creatorFeeOwner: '01'.repeat(32), platformFeeOwner: '02'.repeat(32),
  vKas: 5000, graduationKas: 5000000000,
  creatorFeeBps: 70, platformFeeBps: 30, graduationFeeBps: 500,
};
const response = (params: CpTemplatesResponse['params']): CpTemplatesResponse => ({
  token: { scriptHex: 'aa'.repeat(4), stateStart: 1, maxIns: 4, maxOuts: 4 },
  pool: { scriptHex: 'bb'.repeat(4), stateStart: 2 },
  curve: { scriptHex: 'cc'.repeat(4), stateStart: 3 },
  params,
});

describe('shapeCpTemplates', () => {
  it('hydrates every discriminator from the compiler echo (fix schema: all flags 1)', () => {
    const t = shapeCpTemplates(response({
      ...baseParams,
      canonicalLpInventory: 1, zeroRemoveAllowed: 1, tradeRecipientBound: 1, poolRecipientBound: 1,
      devFundOwner: '05'.repeat(32), devFundBps: 10,
    }));
    expect(t.pool.canonicalInventoryRequired).toBe(true);
    expect(t.pool.zeroRemoveAllowed).toBe(true);
    expect(t.pool.recipientBound).toBe(true);          // ← poolRecipientBound (HLK-L12)
    expect(t.curve.recipientBound).toBe(true);         // ← tradeRecipientBound (HLK-L04)
    expect(t.curve.params.devFundOwner).toEqual(Uint8Array.from(Array(32).fill(5)));
    expect(t.curve.params.devFundBps).toBe(10n);
    expect(t.curve.params.vKas).toBe(5000n);
    expect(t.token.script).toEqual(Uint8Array.from([0xaa, 0xaa, 0xaa, 0xaa]));
    expect(t.token.stateStart).toBe(1);
  });

  // 0.18.1: an echo with NO discriminators at all is a pre-HLK backend, not a legacy token. A current
  // backend emits them as 0/1 for EVERY schema (see the explicit-zero case below), so total absence can only
  // mean "this deployment cannot tell us which ABI the token wants" — silently shaping it to legacy is how
  // the SONAR/WETR "pick at an invalid location" rejections happened. Fail loudly instead.
  it('THROWS on an echo with no discriminators at all (pre-HLK backend), rather than silently shaping legacy', () => {
    expect(() => shapeCpTemplates(response({ ...baseParams }))).toThrow(/no ABI discriminators/);
  });

  it('a single present discriminator is enough to accept the echo (partial backends still shape)', () => {
    const t = shapeCpTemplates(response({ ...baseParams, canonicalLpInventory: 1 }));
    expect(t.pool.canonicalInventoryRequired).toBe(true);
    expect(t.curve.recipientBound).toBe(false);        // absent field within a known-good echo ⇒ legacy
    expect(t.curve.params.devFundOwner).toBeUndefined();
  });

  it('explicit-zero flags also resolve legacy (the echo emits 0, not absence, for known-legacy schemas)', () => {
    const t = shapeCpTemplates(response({
      ...baseParams, canonicalLpInventory: 0, zeroRemoveAllowed: 0, tradeRecipientBound: 0, poolRecipientBound: 0,
    }));
    expect(t.pool.recipientBound).toBe(false);
    expect(t.curve.recipientBound).toBe(false);
  });

  it('does not cross the two recipient flags (curve ← trade, pool ← pool)', () => {
    const curveOnly = shapeCpTemplates(response({ ...baseParams, tradeRecipientBound: 1, poolRecipientBound: 0 }));
    expect(curveOnly.curve.recipientBound).toBe(true);
    expect(curveOnly.pool.recipientBound).toBe(false);
    const poolOnly = shapeCpTemplates(response({ ...baseParams, tradeRecipientBound: 0, poolRecipientBound: 1 }));
    expect(poolOnly.curve.recipientBound).toBe(false);
    expect(poolOnly.pool.recipientBound).toBe(true);
  });
});

describe('fetchCpTemplates', () => {
  const echo = response({ ...baseParams, tradeRecipientBound: 1, poolRecipientBound: 0, zeroRemoveAllowed: 1, canonicalLpInventory: 1 });
  const okFetch = (capture?: (url: string, init: RequestInit) => void) =>
    vi.fn(async (url: string, init: RequestInit) => {
      capture?.(url, init);
      return { ok: true, status: 200, text: async () => JSON.stringify(echo) } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

  const opts = {
    baseUrl: 'https://api.example.test',
    tokenCovid: 'ab'.repeat(32),
    curveParams: { vKas: 5000, creatorFeeBps: 70 },
    templateVersion: { schema: 'cd'.repeat(32), silverc: 'deadbeef' },
  };

  it('returns SHAPED templates — the discriminators are already hydrated', async () => {
    const t = await fetchCpTemplates({ ...opts, fetchImpl: okFetch() });
    expect(t.curve.recipientBound).toBe(true);
    expect(t.pool.recipientBound).toBe(false);          // the WETR-shaped mixed schema
    expect(t.pool.zeroRemoveAllowed).toBe(true);
  });

  it('POSTs curveParams + tokenCovid + templateVersion to the cp-template route', async () => {
    let seenUrl = ''; let body: Record<string, unknown> = {};
    await fetchCpTemplates({ ...opts, fetchImpl: okFetch((u, i) => { seenUrl = u; body = JSON.parse(String(i.body)); }) });
    expect(seenUrl).toBe('https://api.example.test/api/native/cp-template');
    expect(body.vKas).toBe(5000);
    expect(body.tokenCovid).toBe('ab'.repeat(32));
    expect(body.templateVersion).toEqual({ schema: 'cd'.repeat(32), silverc: 'deadbeef' });
  });

  it('trims a trailing slash off baseUrl rather than double-slashing the path', async () => {
    let seenUrl = '';
    await fetchCpTemplates({ ...opts, baseUrl: 'https://api.example.test/', fetchImpl: okFetch((u) => { seenUrl = u; }) });
    expect(seenUrl).toBe('https://api.example.test/api/native/cp-template');
  });

  it('omits templateVersion entirely when null (pre-pinning record), never sends null', async () => {
    let body: Record<string, unknown> = {};
    await fetchCpTemplates({ ...opts, templateVersion: null, fetchImpl: okFetch((_u, i) => { body = JSON.parse(String(i.body)); }) });
    expect('templateVersion' in body).toBe(false);
  });

  it('surfaces a non-2xx as an error carrying the status and body', async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'template compile rate limit' })) as unknown as typeof globalThis.fetch;
    await expect(fetchCpTemplates({ ...opts, fetchImpl: bad })).rejects.toThrow(/429.*rate limit/);
  });

  it('propagates the no-discriminators throw from a pre-HLK backend', async () => {
    const stale = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(response({ ...baseParams })) })) as unknown as typeof globalThis.fetch;
    await expect(fetchCpTemplates({ ...opts, fetchImpl: stale })).rejects.toThrow(/no ABI discriminators/);
  });
});
