// shapeCpTemplates — the ONE mapping from the cp-template response's params echo onto the builders'
// dual-ABI discriminators. A missed or inverted flag here silently builds the wrong ABI (rejected by every
// new-schema token, or arg-stack-corrupting on a legacy one), so the mapping is pinned by test.
import { describe, it, expect } from 'vitest';
import { shapeCpTemplates, type CpTemplatesResponse } from './templates.js';

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

  it('FAILS SAFE on absent flags: an old backend / archived schema resolves to the LEGACY ABI', () => {
    const t = shapeCpTemplates(response({ ...baseParams }));
    expect(t.pool.canonicalInventoryRequired).toBe(false);
    expect(t.pool.zeroRemoveAllowed).toBe(false);
    expect(t.pool.recipientBound).toBe(false);
    expect(t.curve.recipientBound).toBe(false);
    expect(t.curve.params.devFundOwner).toBeUndefined();
    expect(t.curve.params.devFundBps).toBeUndefined();
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
