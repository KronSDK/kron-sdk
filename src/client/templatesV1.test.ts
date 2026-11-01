// client.fetchFamilyTemplates — the KCC-20 standard family's compile route, driven with an injected fetch over the silverc
// v1.0.0 fixture (src/native/__fixtures__/kcc20v1-templates.json). Byte-level checks live in verify:parity:v1.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchFamilyTemplates, shapeFamilyTemplates, familyCurveParamsV1, familyPoolParamsV1, familyCompileBodyV1, POOL_LOCKED_SHARES_DEFAULT_V1, DEX_LP_FEE_BPS_DEFAULT_V1 } from './templatesV1.js';
import { hexOf } from '../native/dispatchTag.js';

const FX = JSON.parse(readFileSync(new URL('../native/__fixtures__/kcc20v1-templates.json', import.meta.url), 'utf8'));
const SCHEMA: string = FX.templateVersion.schema;
const params = { ...FX.params };
const fakeFetch = (answer: unknown, status = 200) => {
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: any, init: any) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: status === 200, status, text: async () => (typeof answer === 'string' ? answer : JSON.stringify(answer)) }; }) as unknown as typeof fetch;
  return { f, calls };
};

describe('familyCurveParamsV1 / familyPoolParamsV1', () => {
  it('maps the registry record onto the builders\' params, with the compiler defaults for absent fields', () => {
    const c = familyCurveParamsV1(params);
    expect(hexOf(c.creatorFeeOwner)).toBe(params.creatorFeeOwner); expect(hexOf(c.creatorIdentifier)).toBe(params.creatorFeeOwner); expect(hexOf(c.devFundOwner)).toBe(params.devFundOwner);
    expect(c.vKas).toBe(1000n); expect(c.graduationKas).toBe(50_000_000n); expect(c.devFundBps).toBe(10n); expect(c.poolLockedShares).toBe(1000n);
    const p = familyPoolParamsV1(params);
    expect(p.creatorFeeBps).toBe(10n); expect(p.platformFeeBps).toBe(70n); expect(p.lpFeeBps).toBe(20n); expect(p.lockedShares).toBe(1000n);
    const { dexLpFeeBps, poolLockedShares, ...bare } = params;
    expect(familyPoolParamsV1(bare).lpFeeBps).toBe(DEX_LP_FEE_BPS_DEFAULT_V1);
    expect(familyCurveParamsV1(bare).poolLockedShares).toBe(POOL_LOCKED_SHARES_DEFAULT_V1);
    expect(familyCurveParamsV1({ ...params, vKas: '1000', creatorFeeBps: '25' }).creatorFeeBps).toBe(25n);
  });
  it('refuses a record without the dev-fund leg or with a malformed key', () => {
    const { devFundOwner, ...noDev } = params;
    expect(() => familyCurveParamsV1(noDev as any)).toThrow(/devFundOwner/);
    expect(() => familyCurveParamsV1({ ...params, devFundBps: null })).toThrow(/devFundBps is required/);
    expect(() => familyCurveParamsV1({ ...params, platformFeeOwner: 'abc' })).toThrow(/32-byte x-only pubkey/);
    expect(() => familyCurveParamsV1({ ...params, vKas: 1.5 })).toThrow(/not an integer/);
  });
});

describe('familyCompileBodyV1', () => {
  it('sends only the family\'s compile keys plus the pin — never maxIns / maxOuts / vesting, which the route refuses', () => {
    const body = familyCompileBodyV1({ ...params, maxIns: 4, maxOuts: 5, vesting: { total: 1 } } as any, { tokenCovid: 'ab'.repeat(32), templateVersion: { schema: SCHEMA } });
    expect(Object.keys(body).sort()).toEqual([...['creatorFeeOwner', 'platformFeeOwner', 'devFundOwner', 'vKas', 'graduationKas', 'creatorFeeBps', 'platformFeeBps', 'graduationFeeBps', 'devFundBps', 'dexCreatorFeeBps', 'dexPlatformFeeBps', 'dexLpFeeBps', 'poolLockedShares'], 'tokenCovid', 'templateVersion'].sort());
    expect(body.templateVersion).toEqual({ family: 'kcc20v1', schema: SCHEMA });
    expect(familyCompileBodyV1(params, { templateVersion: null }).templateVersion).toBeUndefined();
  });
});

describe('fetchFamilyTemplates', () => {
  it('POSTs to /api/native/kcc20v1-template and returns the four templates shaped, hashes recomputed', async () => {
    const { f, calls } = fakeFetch(FX);
    const t = await fetchFamilyTemplates({ baseUrl: 'https://api.example.test/', tokenCovid: 'ab'.repeat(32), curveParams: params, templateVersion: { schema: SCHEMA }, fetchImpl: f });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.test/api/native/kcc20v1-template');
    expect(calls[0].body.templateVersion).toEqual({ family: 'kcc20v1', schema: SCHEMA });
    expect(t.schema).toBe(SCHEMA);
    expect(hexOf(t.token.templateHash)).toBe(FX.token.templateHash);
    expect(hexOf(t.curve.templateHash)).toBe(FX.curve.templateHash);
    expect(hexOf(t.pool.templateHash)).toBe(FX.pool.templateHash);
    expect(hexOf(t.order.templateHash)).toBe(FX.order.templateHash);
    expect(t.curve.params.vKas).toBe(1000n); expect(t.pool.params.lpFeeBps).toBe(20n);
    expect(t.bytes).toEqual({ token: FX.token.bytecodeHex.length / 2, curve: FX.curve.bytecodeHex.length / 2, pool: FX.pool.bytecodeHex.length / 2, order: FX.order.bytecodeHex.length / 2 });
    expect(t.bytes.token).toBe(4031);
    expect(Object.keys(t.curve.tags).sort()).toEqual(['batchBuy', 'buy', 'graduate', 'init', 'sell']);
  });
  it('refuses a tampered program, a non-200, a non-JSON body, and a schema other than the token\'s pin', async () => {
    const opts = { baseUrl: 'https://api.example.test', curveParams: params, templateVersion: { schema: SCHEMA } };
    await expect(fetchFamilyTemplates({ ...opts, fetchImpl: fakeFetch({ ...FX, curve: { ...FX.curve, templateHash: '11'.repeat(32) } }).f })).rejects.toThrow(/curve: server template hash/);
    await expect(fetchFamilyTemplates({ ...opts, fetchImpl: fakeFetch({ error: 'rate limit' }, 429).f })).rejects.toThrow(/kcc20v1-template 429/);
    await expect(fetchFamilyTemplates({ ...opts, fetchImpl: fakeFetch('<html>').f })).rejects.toThrow(/non-JSON/);
    await expect(fetchFamilyTemplates({ ...opts, fetchImpl: fakeFetch({ ...FX, templateVersion: { family: 'kcc20v1', schema: 'ff'.repeat(32) } }).f })).rejects.toThrow(/not the token's pinned/);
    // a compiled tag that disagrees with the entry signature the builders encode for is refused at shaping
    expect(() => shapeFamilyTemplates({ ...FX, pool: { ...FX.pool, dispatchTags: { ...FX.pool.dispatchTags, bindLp: 'deadbeef' } } }, params)).toThrow(/pool\.bindLp: compiled dispatch tag deadbeef/);
  });
});
