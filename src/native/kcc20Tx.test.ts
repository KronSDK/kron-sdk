import { describe, it, expect } from 'vitest';
import { assertTraderTokenInputs, MAX_CURVE_TRADER_TOKEN_INPUTS, type Kcc20Template } from './kcc20Tx.js';

const tpl = (maxIns: number): Kcc20Template => ({ script: new Uint8Array(0), stateStart: 0, maxIns, maxOuts: 5 });

describe('assertTraderTokenInputs', () => {
  it('pool: allows maxIns − 1 trader pieces (3 on every KRON schema) — one slot is the reserve', () => {
    expect(() => assertTraderTokenInputs(tpl(4), 3, 'buildPoolV3SwapTokenForKas')).not.toThrow();
    expect(() => assertTraderTokenInputs(tpl(4), 4, 'buildPoolV3SwapTokenForKas')).toThrow(/limit of 3 per trade \(maxIns 4/);
  });

  it('curve: compute mass caps it at 2, below the kcc20 limit', () => {
    expect(MAX_CURVE_TRADER_TOKEN_INPUTS).toBe(2);
    expect(() => assertTraderTokenInputs(tpl(4), 2, 'buildCpSell', MAX_CURVE_TRADER_TOKEN_INPUTS)).not.toThrow();
    expect(() => assertTraderTokenInputs(tpl(4), 0, 'buildCpBuy', MAX_CURVE_TRADER_TOKEN_INPUTS)).not.toThrow();
    expect(() => assertTraderTokenInputs(tpl(4), 3, 'buildCpSell', MAX_CURVE_TRADER_TOKEN_INPUTS)).toThrow(/buildCpSell: 3 trader token inputs exceeds the limit of 2 per trade \(compute mass/);
  });
});
