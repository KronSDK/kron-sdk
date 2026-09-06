// The unset-discriminator warning. This is the guard that would have caught the SONAR/WETR failures at the
// integrator's console instead of at the node: `recipientBound` unset ⇒ legacy signature script ⇒ two stack
// items short on a recipient-bound covenant ⇒ "pick at an invalid location" at submit.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveRecipientBound, __resetAbiWarnings } from './abiGuard.js';

afterEach(() => {
  __resetAbiWarnings();
  delete (globalThis as { KRON_SDK_SILENCE_ABI_WARNINGS?: unknown }).KRON_SDK_SILENCE_ABI_WARNINGS;
  vi.restoreAllMocks();
});

describe('resolveRecipientBound', () => {
  it('returns the ABI actually used: true ONLY for an explicit true', () => {
    expect(resolveRecipientBound(true, 'b', 'tradeRecipientBound')).toBe(true);
    expect(resolveRecipientBound(false, 'b', 'tradeRecipientBound')).toBe(false);
    expect(resolveRecipientBound(undefined, 'b', 'tradeRecipientBound')).toBe(false);
  });

  it('warns when the flag was never hydrated, naming the node error and the fix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveRecipientBound(undefined, 'buildCpBuy', 'tradeRecipientBound');
    expect(warn).toHaveBeenCalledOnce();
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('buildCpBuy');
    expect(msg).toContain('pick at an invalid location');
    expect(msg).toContain('fetchCpTemplates');
    expect(msg).toContain('tradeRecipientBound');
  });

  // An explicit `false` is a caller ASSERTING a legacy schema — the correct, common case for the great
  // majority of live tokens. Warning on it would train integrators to ignore the warning.
  it('stays silent on an explicit false, and on an explicit true', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveRecipientBound(false, 'buildCpBuy', 'tradeRecipientBound');
    resolveRecipientBound(true, 'buildCpSell', 'tradeRecipientBound');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns ONCE per builder, not once per trade', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) resolveRecipientBound(undefined, 'buildCpBuy', 'tradeRecipientBound');
    expect(warn).toHaveBeenCalledOnce();
    resolveRecipientBound(undefined, 'buildCpSell', 'tradeRecipientBound');
    expect(warn).toHaveBeenCalledTimes(2);              // a different builder gets its own line
  });

  it('honours the global silence escape hatch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as { KRON_SDK_SILENCE_ABI_WARNINGS?: unknown }).KRON_SDK_SILENCE_ABI_WARNINGS = true;
    resolveRecipientBound(undefined, 'buildCpBuy', 'tradeRecipientBound');
    expect(warn).not.toHaveBeenCalled();
  });
});
