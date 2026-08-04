// Value-continuation contract: selection never matches on a KCC-20 UTXO's native value, and a covenant-owned
// CONTINUATION output is emitted at max(dust, inputValue) rather than a bare constant.
//
// WHY THIS FILE EXISTS SEPARATELY FROM verify:parity. The parity gate compares these builders byte-for-byte
// against the kron reference and is the right tool for drift — but its fixtures only ever feed a covenant-owned
// input holding exactly COVENANT_DUST, where `continuationValue(dust, input) === dust`. A builder that dropped
// back to emitting the bare constant would therefore stay byte-identical and parity would pass, while any
// PADDED reserve on a value-continuation-schema token got its transaction rejected by consensus — and because
// that output is the token's only reserve, rejected means wedged permanently. The equal-value case cannot see
// the bug, so this file drives the unequal ones.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  COVENANT_DUST, continuationValue, carrierShortfall, carrierOf,
  selectCovenantUtxo, selectCovenantTokenUtxo, selectCovenantTokenOutpoint,
} from './covenantSelect.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, f), 'utf8');

const A = 'a'.repeat(64);
const utxo = (covid: string | null, amount: bigint, txid = '1'.repeat(64), index = 0) =>
  ({ covenantId: covid, amount, outpoint: { transactionId: txid, index } });

describe('continuationValue', () => {
  it('returns the dust when the input is exactly dust (the case parity exercises)', () => {
    expect(continuationValue(COVENANT_DUST, COVENANT_DUST)).toBe(COVENANT_DUST);
  });

  it('returns the dust when the input was SHAVED — the output heals the UTXO back up', () => {
    expect(continuationValue(COVENANT_DUST, 10_000_000n)).toBe(COVENANT_DUST);
    expect(continuationValue(COVENANT_DUST, 1n)).toBe(COVENANT_DUST);
  });

  it('returns the INPUT when it was PADDED — emitting bare dust there is rejected on chain', () => {
    expect(continuationValue(COVENANT_DUST, COVENANT_DUST + 1n)).toBe(COVENANT_DUST + 1n);
    expect(continuationValue(COVENANT_DUST, 500_000_000n)).toBe(500_000_000n);
  });

  it('never returns less than either side, for any input', () => {
    for (const v of [0n, 1n, 10_000_000n, COVENANT_DUST - 1n, COVENANT_DUST, COVENANT_DUST + 1n, 10n ** 12n]) {
      const out = continuationValue(COVENANT_DUST, v);
      expect(out >= v).toBe(true);            // satisfies `out.value >= in.value`
      expect(out >= COVENANT_DUST).toBe(true); // still above the KIP-9 storage-mass floor
    }
  });
});

describe('every covenant-owned continuation output uses it', () => {
  // Source-level, because building a real transaction needs the wasm SDK and live templates. These are the
  // exact sites the value-continuation covenants constrain; a bare `value: dust` at any of them is the bug.
  const CASES: Array<[string, string, number]> = [
    ['curveCpTx.ts', 'inventory', 2],        // buy + sell
    ['curveCpTx.ts', 'poolToken', 1],        // graduate
    ['poolCpV3Tx.ts', 'poolToken', 2],       // swapKasForToken + swapTokenForKas
    ['poolCpTx.ts', 'poolToken', 2],         // addLiquidity + removeLiquidity
    ['poolCpTx.ts', 'poolLpInventory', 2],   // addLiquidity + removeLiquidity L inventory
  ];
  for (const [file, role, count] of CASES) {
    it(`${file}: all ${count} '${role}' continuation output(s) emit continuationValue`, () => {
      const lines = src(file).split('\n').filter((l) => l.includes(`role: '${role}'`) && l.includes('value:'));
      const emits = lines.filter((l) => !l.includes('transactionId:')); // outputs, not inputs
      expect(emits.length).toBe(count);
      for (const l of emits) expect(l).toContain('continuationValue(');
    });
  }

  it('batchBuy-style absolutely-pinned outputs are NOT converted', () => {
    // `curve_cp.sil` requires batchBuy's token outputs `== ORDER_TOKEN_DUST`, so continuationValue there would
    // produce a rejected transaction against a padded input. If the SDK ever gains a batchBuy builder, its
    // outputs must stay a bare constant — this asserts we have not "consistency-fixed" it.
    const s = src('curveCpTx.ts');
    const batch = s.split('\n').filter((l) => /ORDER_TOKEN_DUST|batchBuy/.test(l) && l.includes('value:'));
    for (const l of batch) expect(l).not.toContain('continuationValue(');
  });
});

describe('selection never matches on value', () => {
  it('finds a covenant-owned balance at any carrier value', () => {
    for (const v of [COVENANT_DUST, 10_000_000n, COVENANT_DUST + 1n, 1n]) {
      expect(selectCovenantTokenUtxo([utxo(A, v)], A)).not.toBeNull();
    }
  });

  it('the pre-fix predicate REJECTS what the fix accepts (the control that matters)', () => {
    const entries = [utxo(A, 10_000_000n)];
    expect(selectCovenantUtxo(entries, A, COVENANT_DUST)).toBeNull();
    expect(selectCovenantTokenUtxo(entries, A)).not.toBeNull();
  });

  it('still fails closed on a wrong covid, on ambiguity, and on a missing covid', () => {
    expect(selectCovenantTokenUtxo([utxo('b'.repeat(64), COVENANT_DUST)], A)).toBeNull();
    expect(selectCovenantTokenUtxo([utxo(A, COVENANT_DUST), utxo(A, COVENANT_DUST, '2'.repeat(64))], A)).toBeNull();
    expect(selectCovenantTokenUtxo([utxo(null, COVENANT_DUST)], A)).toBeNull();
  });

  it('the amount-bearing overload still enforces the amount', () => {
    expect(selectCovenantUtxo([utxo(A, 999n)], A, COVENANT_DUST)).toBeNull();
    expect(selectCovenantUtxo([utxo(A, 999n)], A, null)).not.toBeNull();
  });

  it('the outpoint variant binds outpoint + covid but not value', () => {
    const op = { transactionId: '1'.repeat(64), index: 0 };
    expect(selectCovenantTokenOutpoint([utxo(A, 10_000_000n)], op, A)).not.toBeNull();
    expect(selectCovenantTokenOutpoint([utxo(A, COVENANT_DUST, '2'.repeat(64))], op, A)).toBeNull();
  });
});

describe('funding helpers', () => {
  it('carrierShortfall asks for the top-up only when the input is short', () => {
    expect(carrierShortfall(COVENANT_DUST)).toBe(0n);
    expect(carrierShortfall(COVENANT_DUST + 1n)).toBe(0n);
    expect(carrierShortfall(10_000_000n)).toBe(40_000_000n);
    expect(carrierShortfall(10_000_000n, 20_000_000n)).toBe(70_000_000n);
    expect(carrierShortfall()).toBe(0n);
  });

  it('carrierOf prefers the verified value and does not swallow a genuine zero', () => {
    expect(carrierOf({ value: 10_000_000n })).toBe(10_000_000n);
    expect(carrierOf({ value: 0n })).toBe(0n);
    expect(carrierOf({})).toBe(COVENANT_DUST);
  });
});
