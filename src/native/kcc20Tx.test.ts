import { describe, it, expect } from 'vitest';
import { assertTraderTokenInputs, type Kcc20Template } from './kcc20Tx.js';

const tpl = (maxIns: number): Kcc20Template => ({ script: new Uint8Array(0), stateStart: 0, maxIns, maxOuts: 5 });

describe('assertTraderTokenInputs', () => {
  it('allows maxIns − 1 trader pieces (3 on every KRON schema): one slot is the inventory / reserve', () => {
    expect(() => assertTraderTokenInputs(tpl(4), 3, 'buildCpSell')).not.toThrow();
    expect(() => assertTraderTokenInputs(tpl(4), 0, 'buildCpBuy')).not.toThrow();
  });

  it('throws at build time past the cap, naming the builder and the limit', () => {
    expect(() => assertTraderTokenInputs(tpl(4), 4, 'buildCpSell')).toThrow(/buildCpSell: 4 trader token inputs exceeds the token's limit of 3/);
  });
});
