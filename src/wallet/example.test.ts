import { describe, it, expect, afterEach } from 'vitest';
import { ExampleWalletAdapter } from './example.js';

const X = 'a'.repeat(64); // stand-in 32-byte x-only coordinate
const Y = 'b'.repeat(64); // a DIFFERENT trailing coordinate (uncompressed keys carry Y after X)

function setPubkey(hex: string) {
  (globalThis as any).exampleWallet = { getPublicKey: async () => hex };
}

describe('ExampleWalletAdapter.getXOnlyPublicKey (BUG 7 regression)', () => {
  afterEach(() => { delete (globalThis as any).exampleWallet; });

  it('returns a raw x-only key unchanged', async () => {
    setPubkey(X);
    expect(await new ExampleWalletAdapter().getXOnlyPublicKey()).toBe(X);
  });

  it('drops the 02/03 prefix on a compressed key', async () => {
    setPubkey('02' + X);
    expect(await new ExampleWalletAdapter().getXOnlyPublicKey()).toBe(X);
    setPubkey('03' + X);
    expect(await new ExampleWalletAdapter().getXOnlyPublicKey()).toBe(X);
  });

  it('takes X (not the trailing Y) from an uncompressed key', async () => {
    setPubkey('04' + X + Y);
    expect(await new ExampleWalletAdapter().getXOnlyPublicKey()).toBe(X);
  });

  it('tolerates a 0x prefix and mixed case', async () => {
    setPubkey('0x02' + X.toUpperCase());
    expect(await new ExampleWalletAdapter().getXOnlyPublicKey()).toBe(X);
  });
});
