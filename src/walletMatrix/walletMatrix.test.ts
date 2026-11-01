// The wallet matrix (walletMatrix): the four shapes match KRON's /dev/wallet-matrix page (input layout, request sizes and
// the mass the page recorded for Kastle and KasWare on 2026-10-27), they spend fake outpoints only, a canonical wallet of
// either KCC-12 shape passes every shape, and non-canonical or tampered answers are refused shape by shape.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadKaspa, type Kaspa } from '../wasm/index.node.js';
import type { WalletAdapter } from '../wallet/types.js';
import { massDimsV1 } from '../native/covenantTxKcc20V1.js';
import { REFERENCE_TEMPLATES_V1 } from './referenceTemplates.js';
import {
  WALLET_MATRIX_RECORD_VERSION, WALLET_MATRIX_SHAPES, WALLET_MATRIX_NOTE, buildWalletMatrixShapes, runWalletMatrix, withApprovalScreens,
  formatWalletMatrixRecord, referenceTemplatesV1, type WalletMatrixRecord,
} from './walletMatrix.js';

const FX = JSON.parse(readFileSync(new URL('../native/__fixtures__/kcc20v1-templates.json', import.meta.url), 'utf8'));
const NET = 'testnet-10';
type Key = { pk: any; hex: string; address: string };
let k: Kaspa, holder: Key, other: Key;

const keyOf = (seed: string): Key => {
  const kk = k as any;
  const pk = new kk.PrivateKey(seed.repeat(32));
  const hex = String(pk.toPublicKey().toXOnlyPublicKey().toString()).replace(/^0x/, '');
  return { pk, hex, address: kk.addressFromScriptPublicKey(new kk.ScriptPublicKey(0, `20${hex}ac`), NET).toString() };
};

beforeAll(async () => {
  k = await loadKaspa();
  holder = keyOf('b5');
  other = keyOf('b2');
}, 60_000);

// --- fake wallets ------------------------------------------------------------------------------------------------------
/** sig65 = `sig64 ‖ 01` for input `index`, from the SDK's createInputSignature (which returns `41 ‖ sig64 ‖ 01`). */
const sig65 = (txJson: string, index: number, pk: any): string => {
  const kk = k as any;
  const full = String(kk.createInputSignature(kk.Transaction.deserializeFromSafeJSON(txJson), index, pk, kk.SighashType.All)).replace(/^0x/, '');
  return full.length === 132 ? full.slice(2) : full;
};
const seen: string[] = []; // every signature a fake wallet handed out, to prove the record never carries one
const base = (who: Key, extra: Partial<WalletAdapter>): WalletAdapter => ({
  provider: 'fake', label: 'FakeWallet', isAvailable: () => true,
  capabilities: () => ({ signPskt: !!extra.signPskt, getXOnlyPublicKey: true, signMessage: false, reconnect: false, signInputs: !!extra.signInputs }),
  connect: async () => who.address, getAddress: () => who.address, getXOnlyPublicKey: async () => who.hex, disconnect() {}, ...extra,
});
/** signPskt sign-and-extract; `script` turns sig65 into what the wallet writes (canonical: `41 ‖ sig65`). */
const psktWallet = (who: Key, o: { script?: (s65: string) => string; mutate?: (j: any) => void } = {}) => base(who, {
  covenantInputSigning: 'unproven',
  async signPskt(txJson, signInputs) {
    const j = JSON.parse(txJson);
    for (const { index } of signInputs) { const s = sig65(txJson, index, who.pk); seen.push(s.slice(0, 128)); j.inputs[index].signatureScript = o.script ? o.script(s) : `41${s}`; }
    o.mutate?.(j);
    return JSON.stringify(j);
  },
});
/** KCC-12 §6.7 kaspa_signInputs; `sig` turns sig65 into what the wallet returns (canonical: the 64 raw bytes). */
const signInputsWallet = (who: Key, o: { sig?: (s65: string) => string } = {}) => base(who, {
  covenantInputSigning: 'signInputs',
  async signInputs(txJson, inputs) {
    return inputs.map(({ index, address }) => {
      if (address !== who.address) throw Object.assign(new Error(`address ${address} is not an authorized account`), { code: 4100 });
      const s = sig65(txJson, index, who.pk); seen.push(s.slice(0, 128));
      return o.sig ? o.sig(s) : s.slice(0, 128);
    });
  },
});
const run = (w: WalletAdapter, extra: Partial<Parameters<typeof runWalletMatrix>[2]> = {}) => runWalletMatrix(k, w, { network: NET, build: 'FakeWallet 0.0.1 (test)', ...extra });
const statuses = (r: WalletMatrixRecord) => r.results.map((x) => x.status);

// The mass c/t/s of KRON's page shapes with the live programs (schema 6b7ec42cd29a), from KRON's own builders. KRON's page
// recorded the same transfers for Kastle and KasWare on krontest.xyz on 2026-10-27 (kron docs/kcc20-spike/WALLET-SIGNING.md),
// and 124046/40592/318977 (sell) and 103534/40248/310106 (buy) with that day's curve, 120 bytes shorter: the singleton
// proof in init (audit KV1-01) adds 145 compute and 290 transient mass to each curve shape.
const PAGE_MASS: Record<string, string> = {
  'transfer (1 piece)': '22600/1120/158562',
  'transfer (2 pieces)': '42283/1186/76203',
  'sell (2 pieces + change)': '124191/40882/318977',
  'buy (1 merge)': '103679/40538/310106',
};
const PAGE_REQUESTED: Record<string, { token: number; funding: number }> = {
  'transfer (1 piece)': { token: 1, funding: 1 }, 'transfer (2 pieces)': { token: 2, funding: 1 },
  'sell (2 pieces + change)': { token: 2, funding: 1 }, 'buy (1 merge)': { token: 1, funding: 1 },
};

describe('walletMatrix — the four shapes', () => {
  it('the bundled reference programs are the parity fixture\'s token and curve programs (re-run scripts/gen-wallet-matrix-templates.mjs if this fails)', () => {
    for (const name of ['token', 'curve'] as const) {
      for (const f of ['bytecodeHex', 'stateSpan', 'prefixLen', 'suffixLen', 'templateHash', 'dispatchTags'] as const) expect(REFERENCE_TEMPLATES_V1[name][f], `${name}.${f}`).toEqual(FX[name][f]);
    }
    expect(REFERENCE_TEMPLATES_V1.params).toEqual(FX.params);
    expect(REFERENCE_TEMPLATES_V1.schema).toBe(FX.templateVersion.schema);
    expect(referenceTemplatesV1().schema).toBe(FX.templateVersion.schema);
  });

  it('builds the page\'s shapes: same order, same token/funding split, same mass as the page recorded', () => {
    const shapes = buildWalletMatrixShapes(k, { holderPubkey: holder.hex, address: holder.address, network: NET });
    expect(shapes.map((s) => s.shape)).toEqual([...WALLET_MATRIX_SHAPES]);
    for (const s of shapes) {
      expect({ token: s.asm.tokenSignInputIndexes.length, funding: s.asm.fundingInputIndexes.length }, s.shape).toEqual(PAGE_REQUESTED[s.shape]);
      expect(s.signIndexes).toEqual([...s.asm.fundingInputIndexes, ...s.asm.tokenSignInputIndexes]);
      const m = massDimsV1(k, s.asm.transaction, NET, s.signIndexes);
      expect(`${m.compute}/${m.transient}/${m.storage}`, s.shape).toBe(PAGE_MASS[s.shape]);
    }
  });

  it('every input spends a fake outpoint (txid = one byte 0xa0..0xa4 repeated), so nothing signed can be broadcast', () => {
    for (const s of buildWalletMatrixShapes(k, { holderPubkey: holder.hex, address: holder.address, network: NET })) {
      const j = JSON.parse(s.asm.transaction.serializeToSafeJSON());
      for (const inp of j.inputs) expect(inp.transactionId, s.shape).toMatch(/^(a[0-4])\1{31}$/);
    }
  });
});

describe('walletMatrix — runWalletMatrix', () => {
  it('a canonical signPskt wallet passes every shape: 66-byte `…01` answers on token and funding inputs, the page\'s record shape', async () => {
    const r = await run(psktWallet(holder), { approvalScreens: { 'buy (1 merge)': 'Sign 2 inputs' } });
    expect(Object.keys(r)).toEqual(['v', 'recordedAt', 'network', 'wallet', 'synthetic', 'note', 'results']);
    expect(r.v).toBe(WALLET_MATRIX_RECORD_VERSION);
    expect(r.v).toBe('KRON-WALLET-MATRIX-1');
    expect(r.network).toBe(NET);
    expect(r.synthetic).toBe(true);
    expect(r.note).toBe(WALLET_MATRIX_NOTE);
    expect(Number.isNaN(Date.parse(r.recordedAt))).toBe(false);
    expect(r.wallet).toEqual({ label: 'FakeWallet', provider: 'fake', covenantInputSigning: 'unproven', signInputs: false, signPskt: true, build: 'FakeWallet 0.0.1 (test)' });
    expect(statuses(r)).toEqual(['ok', 'ok', 'ok', 'ok']);
    for (const row of r.results) {
      expect(Object.keys(row)).toEqual(['shape', 'status', 'path', 'requested', 'answer', 'error', 'ms', 'mass', 'approvalScreen']);
      const want = PAGE_REQUESTED[row.shape];
      expect(row.path).toBe('signPskt');
      expect(row.requested).toBe(want.token + want.funding);
      expect(row.answer!.filter((a) => a.kind === 'token').length).toBe(want.token);
      expect(row.answer!.every((a) => a.bytes === 66 && a.tail === '01')).toBe(true);
      expect(row.error).toBeNull();
      expect(typeof row.ms).toBe('number');
      expect(`${row.mass!.compute}/${row.mass!.transient}/${row.mass!.storage}`).toBe(PAGE_MASS[row.shape]);
    }
    expect(r.results.map((x) => x.approvalScreen)).toEqual(['', '', '', 'Sign 2 inputs']);
  });

  it('a canonical kaspa_signInputs wallet passes every shape on the signInputs path (64-byte raw answers)', async () => {
    const r = await run(signInputsWallet(holder));
    expect(r.wallet?.covenantInputSigning).toBe('signInputs');
    expect(r.wallet?.signInputs).toBe(true);
    expect(statuses(r)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(r.results.every((x) => x.path === 'signInputs' && x.answer!.every((a) => a.bytes === 64))).toBe(true);
  });

  it('refuses a non-canonical signPskt answer on every shape: the double-wrapped 67-byte `42 41 sig 01`, a 0x02 tail, a bare 65-byte sig', async () => {
    const wrapped = await run(psktWallet(holder, { script: (s) => `4241${s}` }));
    expect(statuses(wrapped)).toEqual(['error', 'error', 'error', 'error']);
    expect(wrapped.results.every((x) => /67-byte/.test(x.error!) && x.path === null && x.answer === null && x.mass === null && x.requested === null)).toBe(true);
    const tail02 = await run(psktWallet(holder, { script: (s) => `41${s.slice(0, 128)}02` }));
    expect(statuses(tail02)).toEqual(['error', 'error', 'error', 'error']);
    const bare = await run(psktWallet(holder, { script: (s) => s }));
    expect(statuses(bare)).toEqual(['error', 'error', 'error', 'error']);
  });

  it('refuses a non-canonical signInputs answer: 65 bytes ending 0x02, 63 bytes, the 66-byte script instead of the raw signature', async () => {
    for (const sig of [(s: string) => `${s.slice(0, 128)}02`, (s: string) => s.slice(0, 126), (s: string) => `41${s}`]) {
      const r = await run(signInputsWallet(holder, { sig }));
      expect(statuses(r)).toEqual(['error', 'error', 'error', 'error']);
      expect(r.results.every((x) => /not 64 raw bytes or 65 bytes ending in SIGHASH_ALL/.test(x.error!))).toBe(true);
    }
  });

  it('refuses a signPskt answer that changes anything but the requested signatures (an output value)', async () => {
    const r = await run(psktWallet(holder, { mutate: (j) => { j.outputs[j.outputs.length - 1].value = String(BigInt(j.outputs[j.outputs.length - 1].value) - 1n); } }));
    expect(statuses(r)).toEqual(['error', 'error', 'error', 'error']);
  });

  it('a wallet that declares it refuses covenant inputs fails closed before any prompt', async () => {
    let asked = 0;
    const w = base(holder, { covenantInputSigning: 'refused', async signPskt() { asked++; return ''; } });
    const r = await run(w);
    expect(statuses(r)).toEqual(['error', 'error', 'error', 'error']);
    expect(asked).toBe(0);
    expect(r.results[0].error).toMatch(/declines to sign covenant inputs/);
  });

  it('one bad shape does not stop the run; onProgress announces each request before the wallet is asked', async () => {
    let calls = 0;
    const good = psktWallet(holder);
    const flaky = base(holder, { covenantInputSigning: 'unproven', async signPskt(txJson, s) { calls++; if (calls === 2) throw new Error('User rejected the request'); return good.signPskt!(txJson, s); } });
    const events: string[] = [];
    const r = await run(flaky, { onProgress: (e) => events.push(`${e.phase}:${e.shape}${e.phase === 'done' ? `:${e.result.status}` : ''}`) });
    expect(statuses(r)).toEqual(['ok', 'error', 'ok', 'ok']);
    expect(r.results[1].error).toBe('User rejected the request');
    expect(events).toEqual(WALLET_MATRIX_SHAPES.flatMap((s, i) => [`signing:${s}`, `done:${s}:${i === 1 ? 'error' : 'ok'}`]));
  });

  it('throws before any prompt on mainnet, without an address or key, or when the address is not the key\'s address on the network', async () => {
    await expect(runWalletMatrix(k, psktWallet(holder), { network: 'mainnet', build: 'x' })).rejects.toThrow(/testnet tool/);
    await expect(run(base(holder, { getAddress: () => null, async signPskt() { throw new Error('asked'); } }))).rejects.toThrow(/connect FakeWallet first/);
    await expect(run(base(holder, { getXOnlyPublicKey: async () => null }))).rejects.toThrow(/did not return its public key/);
    await expect(run(base(holder, { getXOnlyPublicKey: async () => other.hex }))).rejects.toThrow(/is not the testnet-10 address of the public key/);
    await expect(runWalletMatrix(k, psktWallet(holder), { network: 'testnet-11', build: 'x' })).resolves.toBeTruthy(); // same kaspatest: prefix
  });

  it('the record is plain JSON, carries no signature bytes, and takes approval-screen text afterwards', async () => {
    seen.length = 0;
    const r = await run(signInputsWallet(holder));
    const text = formatWalletMatrixRecord(r);
    expect(JSON.parse(text)).toEqual(r);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(text.includes(s)).toBe(false);
    const filled = withApprovalScreens(r, { 'transfer (1 piece)': 'Approve 2 inputs (1 P2SH)' });
    expect(filled.results[0].approvalScreen).toBe('Approve 2 inputs (1 P2SH)');
    expect(r.results[0].approvalScreen).toBe('');
    expect(() => withApprovalScreens(r, { 'transfer (3 pieces)': 'x' } as any)).toThrow(/unknown shape/);
  });
});
