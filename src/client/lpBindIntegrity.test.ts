// Counterfeit-LP defence: the IndexerClient LP-bind gate + the buildAddLiquidity tripwire.
// See CpState.lpBindVerified — pools on the pre-e5469a7ad482 covenant can be counterfeit-bound so that added
// liquidity is drained; only a proven-honest pool (L supply == MAX_SHARES − lockedShares, reported by the
// indexer) may receive liquidity. removeLiquidity is never gated.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { IndexerClient } from './indexerClient.js';
import { buildAddLiquidity } from '../native/poolCpTx.js';

const meta = (lpBindVerified: boolean | null | undefined) => ({
  message: 'successful',
  result: [{ tick: 'tok', cpState: { realKas: 0, tokenReserve: 0, graduated: true, ...(lpBindVerified === undefined ? {} : { lpBindVerified }) } }],
});
const mockToken = (lpBindVerified: boolean | null | undefined) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => meta(lpBindVerified) } as any);

describe('IndexerClient LP-bind gate', () => {
  afterEach(() => vi.restoreAllMocks());
  const c = () => new IndexerClient('https://idx.example/v1/kcc20');

  it('lpBindVerified maps true/false/absent → true/false/null (fail-safe)', async () => {
    mockToken(true);   expect(await c().lpBindVerified('tok')).toBe(true);
    vi.restoreAllMocks(); mockToken(false); expect(await c().lpBindVerified('tok')).toBe(false);
    vi.restoreAllMocks(); mockToken(undefined); expect(await c().lpBindVerified('tok')).toBe(null);
    vi.restoreAllMocks(); mockToken(null); expect(await c().lpBindVerified('tok')).toBe(null);
  });

  it('assertLpBindSafe: passes only on verified true', async () => {
    mockToken(true);
    await expect(c().assertLpBindSafe('tok')).resolves.toBeUndefined();
  });
  it('assertLpBindSafe: throws on a counterfeit (false)', async () => {
    mockToken(false);
    await expect(c().assertLpBindSafe('tok')).rejects.toThrow(/failed an on-chain integrity check/);
  });
  it('assertLpBindSafe: throws on unverifiable (null/absent) — fail-safe', async () => {
    mockToken(undefined);
    await expect(c().assertLpBindSafe('tok')).rejects.toThrow(/not confirmed yet/);
  });
});

describe('buildAddLiquidity tripwire', () => {
  // The tripwire fires BEFORE any argument is dereferenced, so passing 10 undefined positional args + opts is
  // enough to prove the gate (opts is the 11th param). It must throw before the "Cannot read undefined" that
  // real args would otherwise cause.
  const call = (opts: any) => (buildAddLiquidity as (...a: any[]) => unknown)(...Array(10).fill(undefined), opts);
  it('throws when the passed flag is explicitly false', () => {
    expect(() => call({ lpBindVerified: false })).toThrow(/LP-bind integrity is FAILED/);
  });
  it('throws when the passed flag is null (unverified)', () => {
    expect(() => call({ lpBindVerified: null })).toThrow(/LP-bind integrity is UNVERIFIED/);
  });
  // FAIL CLOSED (0.17.0). Omitting the flag used to skip the gate entirely, so an integrator who never read
  // the docs built an unguarded addLiquidity. A gate whose failure mode is a drained deposit must not default
  // to silence.
  it('throws when the flag is omitted — the gate is not opt-in', () => {
    expect(() => call({})).toThrow(/LP-bind integrity is UNVERIFIED/);
  });
  it('throws when opts itself is omitted', () => {
    expect(() => (buildAddLiquidity as (...a: any[]) => unknown)(...Array(10).fill(undefined)))
      .toThrow(/LP-bind integrity is UNVERIFIED/);
  });
  it('builds past the gate only on an explicit true (then fails on the real args, not the gate)', () => {
    expect(() => call({ lpBindVerified: true })).not.toThrow(/LP-bind integrity/);
  });
});
