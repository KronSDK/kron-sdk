import { describe, it, expect } from 'vitest';
import {
  assertTraderTokenInputs, MAX_CURVE_TRADER_TOKEN_INPUTS, materializeKcc20Script, pushKcc20StateScalar, pushKcc20States,
  covenantIdOwned, addressPresenceOwned, type Kcc20Template, type Kcc20State, type IdentifierType,
} from './kcc20Tx.js';

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

// Only the 46-byte state region, between two opcodes: enough for the splice, so no silverc build is needed.
const regionTpl: Kcc20Template = {
  script: Uint8Array.from([0x51, 0x20, ...new Uint8Array(32), 0x01, 0x00, 0x08, ...new Uint8Array(8), 0x01, 0x00, 0x51]),
  stateStart: 1, maxIns: 4, maxOuts: 5,
};
const ZERO32 = new Uint8Array(32);
const rawState = (ownerIdentifier: Uint8Array, identifierType: unknown): Kcc20State =>
  ({ ownerIdentifier, identifierType: identifierType as IdentifierType, amount: 500n, isMinter: false });
// KRON's own messages (kron web/src/native/kcc20Tx.ts assertSpendableKcc20State), word for word.
const ZERO_COVID = /^kcc20 covenant-id owner must not be all-zero: OpInputCovenantId returns the zero hash for any ordinary input, making the balance anyone-can-spend$/;
const BAD_TYPE = (got: string) => new RegExp(`^kcc20 identifierType must be 0-3 \\(got ${got}\\); a successor outside this range is permanently unspendable$`);

describe('materializeKcc20Script refuses the token states KRON refuses (HLK-L09, HLK-L10)', () => {
  it('throws on a covenant-id (0x02) owner of 32 zero bytes, which anyone can spend on schemas before bdbcfb2540d1…', () => {
    expect(() => materializeKcc20Script(regionTpl, covenantIdOwned(ZERO32, 500n))).toThrow(ZERO_COVID);
    expect(() => materializeKcc20Script(regionTpl, covenantIdOwned(new Uint8Array(32).fill(0xcc), 500n))).not.toThrow();
  });

  it('throws on identifierType 4, a balance no transfer branch can ever move', () => {
    expect(() => materializeKcc20Script(regionTpl, rawState(new Uint8Array(32).fill(0xa5), 4))).toThrow(BAD_TYPE('4'));
  });

  it('builds 32 zero bytes under ADDRESS (0x03): the burn address kaspa:qqqq…kx9awp4e, a legitimate sink', () => {
    expect(Array.from(materializeKcc20Script(regionTpl, addressPresenceOwned(ZERO32, 500n))))
      .toEqual([0x51, 0x20, ...ZERO32, 0x01, 0x03, 0x08, 0xf4, 0x01, 0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x51]);
  });

  it('throws on a type that is not an integer, which the splice would store as 0x02 past the zero-owner check', () => {
    expect(() => materializeKcc20Script(regionTpl, rawState(ZERO32, '2'))).toThrow(BAD_TYPE('2'));
    expect(() => materializeKcc20Script(regionTpl, rawState(ZERO32, 2.5))).toThrow(BAD_TYPE('2\\.5'));
  });

  it('the signature-script pushes refuse them too, before they touch the builder', () => {
    const b = {} as never;
    expect(() => pushKcc20StateScalar(b, covenantIdOwned(ZERO32, 500n))).toThrow(ZERO_COVID);
    expect(() => pushKcc20States(b, [addressPresenceOwned(ZERO32, 1n), covenantIdOwned(ZERO32, 500n)])).toThrow(ZERO_COVID);
    expect(() => pushKcc20States(b, [rawState(ZERO32, 7)])).toThrow(BAD_TYPE('7'));
  });
});
