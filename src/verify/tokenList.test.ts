import { describe, it, expect } from 'vitest';
import { verifyTokenListEntry, kaspaRestFetchTx, canonicalTokenListMsg, verifyTokenListSignature } from './tokenList.js';
import type { SignedTokenList } from './tokenList.js';
import type { TokenListEntry } from '../client/registryClient.js';

const COVID_A = 'aa'.repeat(32);
const COVID_C = 'cc'.repeat(32);
const TXID = '11'.repeat(32);

const entry = (over: Partial<TokenListEntry> = {}): TokenListEntry => ({
  network: 'testnet-10',
  covenantId: COVID_A,
  symbol: 'GHOST', name: 'Ghost', decimals: 0,
  extensions: {
    curveCovenantId: COVID_C, poolCovenantId: null, genesisTxid: TXID,
    creator: null, creatorPubkey: null, curveParams: null,
    templateVersion: { schema: '39'.repeat(32), silverc: '2c'.repeat(20) }, // covenant version pin (server-stamped)
    graduated: false, chainVerified: true,
  },
  ...over,
});

describe('verifyTokenListEntry', () => {
  it('ok when covid A is present as a covenant_id on a genesis-tx output', async () => {
    const tx = { outputs: [{ covenant_id: COVID_C }, { covenant_id: COVID_A }] };
    const r = await verifyTokenListEntry(entry(), async () => tx);
    expect(r).toEqual({ ok: true, covenantIdPresent: true });
  });

  it('is case-insensitive and accepts the camelCase covenantId field', async () => {
    const tx = { outputs: [{ covenantId: COVID_A.toUpperCase() }] };
    const r = await verifyTokenListEntry(entry(), async () => tx);
    expect(r.ok).toBe(true);
  });

  it('fails when covid A is absent from all outputs', async () => {
    const tx = { outputs: [{ covenant_id: COVID_C }] };
    const r = await verifyTokenListEntry(entry(), async () => tx);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found on any output/);
  });

  it('fails (no throw) when the entry has no genesisTxid', async () => {
    const e = entry(); e.extensions.genesisTxid = null;
    const r = await verifyTokenListEntry(e, async () => ({ outputs: [] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/genesisTxid/);
  });

  it('surfaces a fetchTx failure as a reason, not a throw', async () => {
    const r = await verifyTokenListEntry(entry(), async () => { throw new Error('boom'); });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fetchTx failed.*boom/);
  });

  it('tolerates a tx with no outputs array', async () => {
    const r = await verifyTokenListEntry(entry(), async () => ({}) as any);
    expect(r.ok).toBe(false);
  });

  it('is version-independent: a pre-pinning legacy entry (templateVersion null) still verifies', async () => {
    const e = entry(); e.extensions.templateVersion = null;
    const tx = { outputs: [{ covenant_id: COVID_A }] };
    const r = await verifyTokenListEntry(e, async () => tx);
    expect(r.ok).toBe(true);
  });
});

describe('kaspaRestFetchTx', () => {
  it('builds the Kaspa REST URL and strips a trailing slash', async () => {
    let called = '';
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: any) => { called = String(url); return { ok: true, json: async () => ({ outputs: [] }) }; }) as any;
    try {
      await kaspaRestFetchTx('https://api-tn10.kaspa.org/')(TXID);
      expect(called).toBe(`https://api-tn10.kaspa.org/transactions/${TXID}?outputs=true`);
    } finally { globalThis.fetch = orig; }
  });
});

const PUB = '18'.repeat(32);
const signedList = (over: Partial<SignedTokenList> = {}): SignedTokenList => ({
  name: 'KRON',
  timestamp: '2026-07-27T00:00:00.000Z',
  version: { major: 1, minor: 2, patch: 3 },
  network: 'mainnet',
  keywords: ['kron'],
  variant: { all: false, tier: null },
  signature: 'deadbeef',
  publicKey: PUB,
  tokens: [entry()],
  ...over,
});
/** A fake verifyMessage that recomputes nothing — "valid" means the canonical message of the passed
 *  document matches the canonical message the signature was "issued" for. Real crypto is covered by
 *  scripts/verify-parity.mjs (cross-repo round-trip against backend/tokenListSignature.mjs). */
const fakeKaspaFor = (issuedFor: SignedTokenList, expectedKey = PUB) => ({
  verifyMessage: (a: { message: string; signature: string; publicKey: string }) =>
    a.message === canonicalTokenListMsg(issuedFor) && a.publicKey === expectedKey,
});

describe('canonicalTokenListMsg', () => {
  it('golden string: exact canonical bytes are a contract with backend/tokenListSignature.mjs', () => {
    const doc: SignedTokenList = {
      name: 'KRON', timestamp: '2026-07-27T00:00:00.000Z',
      version: { major: 1, minor: 1, patch: 2 }, network: 'Mainnet', keywords: ['kron'],
      variant: { all: false, tier: null }, signature: 'sig', publicKey: PUB,
      tokens: [{ network: 'mainnet', covenantId: 'aa', symbol: 'TKN', name: 'T', decimals: 0, extensions: { genesisTxid: 'cc' } } as any],
    };
    expect(canonicalTokenListMsg(doc)).toBe(
      '{"v":"KRON-TOKENLIST-1","network":"mainnet","variant":{"all":false,"tier":null},'
      + '"version":{"major":1,"minor":1,"patch":2},'
      + '"tokens":[{"network":"mainnet","covenantId":"aa","symbol":"TKN","name":"T","decimals":0,"extensions":{"genesisTxid":"cc"}}]}',
    );
  });

  it('excludes the volatile timestamp and binds the variant', () => {
    const doc = signedList();
    expect(canonicalTokenListMsg(doc)).toBe(canonicalTokenListMsg({ ...doc, timestamp: 'tampered' }));
    expect(canonicalTokenListMsg(doc)).not.toBe(canonicalTokenListMsg({ ...doc, variant: { all: true, tier: null } }));
  });
});

describe('verifyTokenListSignature', () => {
  it('verifies against a pinned key', () => {
    const doc = signedList();
    const r = verifyTokenListSignature(fakeKaspaFor(doc), doc, { pinnedPublicKey: PUB });
    expect(r).toEqual({ ok: true, signed: true, keySource: 'pinned' });
  });

  it('pinned key wins: a response naming a different signer fails without calling verifyMessage', () => {
    const doc = signedList({ publicKey: 'ff'.repeat(32) });
    let called = false;
    const kaspa = { verifyMessage: () => { called = true; return true; } };
    const r = verifyTokenListSignature(kaspa, doc, { pinnedPublicKey: PUB });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/signer mismatch/);
    expect(called).toBe(false);
  });

  it('normalizes pinned keys: 0x / 02-compressed forms match the x-only response key', () => {
    const doc = signedList();
    expect(verifyTokenListSignature(fakeKaspaFor(doc), doc, { pinnedPublicKey: `0x${PUB}` }).ok).toBe(true);
    expect(verifyTokenListSignature(fakeKaspaFor(doc), doc, { pinnedPublicKey: `02${PUB}` }).ok).toBe(true);
  });

  it('falls back to the response key (trust-on-first-use) when no pin is given', () => {
    const doc = signedList();
    const r = verifyTokenListSignature(fakeKaspaFor(doc), doc);
    expect(r).toEqual({ ok: true, signed: true, keySource: 'response' });
  });

  it('reports an unsigned list as signed:false, not a forgery', () => {
    const r = verifyTokenListSignature(fakeKaspaFor(signedList()), signedList({ signature: undefined, publicKey: undefined, variant: undefined }));
    expect(r).toEqual({ ok: false, signed: false, reason: expect.stringMatching(/unsigned/) });
  });

  it('fails closed on a signed list with no variant field', () => {
    const r = verifyTokenListSignature(fakeKaspaFor(signedList()), signedList({ variant: undefined }), { pinnedPublicKey: PUB });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no variant/);
  });

  it('rejects a cross-variant replay: an ?all=1 document served as the curated default', () => {
    const doc = signedList({ variant: { all: true, tier: null } });
    const r = verifyTokenListSignature(fakeKaspaFor(doc), doc, { pinnedPublicKey: PUB }); // expectedVariant defaults to {all:false,tier:null}
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/variant mismatch.*replay/);
    expect(verifyTokenListSignature(fakeKaspaFor(doc), doc, { pinnedPublicKey: PUB, expectedVariant: { all: true } }).ok).toBe(true);
  });

  it('a tampered document fails and a verifyMessage throw is surfaced as a reason, never thrown', () => {
    const doc = signedList();
    const tampered = { ...doc, tokens: [{ ...doc.tokens[0], symbol: 'EVIL' }] };
    expect(verifyTokenListSignature(fakeKaspaFor(doc), tampered, { pinnedPublicKey: PUB }).ok).toBe(false);
    const throwing = { verifyMessage: () => { throw new Error('wasm not loaded'); } };
    const r = verifyTokenListSignature(throwing, doc, { pinnedPublicKey: PUB });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/wasm not loaded/);
  });
});
