// Dev-allocation VESTING covenant builder — wires vesting.sil into Kaspa transactions. The lock OWNS the dev
// allocation (a covid-A kcc20 token) and releases it to the creator's presence only as it vests (gated by
// tx.locktime). This module covers the claim side (claim / claimFinal) against an already-deployed lock.
//
// State region (silverc state_layout {start:1, len:9}): off 1: 0x08 <claimed: 8-byte LE int>.
// No top-level SDK import (only `import type`) — caller passes the loaded WASM namespace `k`.
import type { Kaspa } from '../wasm/kaspa.types.js';
import { SigScriptBuilder, int8LE } from './sigscript.js';
import {
  type Kcc20Template,
  type Kcc20State,
  materializeKcc20Script,
  kcc20Spk,
  covenantIdOwned,
  addressPresenceOwned,
  pushKcc20StateScalar,
  transferSigScript,
} from './kcc20Tx.js';
import type { CovenantSpend, CovInput, CovOutput } from './spend.js';

type K = Kaspa;
type Spk = any;

// entrypoint selectors — vesting.sil declares claim then claimFinal
export const VEST_SELECTOR = { claim: 0, claimFinal: 1 } as const;

const hexOf = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

/** Tokens vested by DAA score `daaScore` (linear from startScore over durationScore; capped at total). Mirrors
 *  the covenant's cross-multiplied bound exactly, so the flow can offer `vested − claimed` to claim. */
export function vestedAmount(total: bigint, startScore: number, durationScore: number, daaScore: number): bigint {
  if (daaScore <= startScore) return 0n;
  const elapsed = BigInt(daaScore - startScore);
  const dur = BigInt(durationScore);
  if (elapsed >= dur) return total;
  return (total * elapsed) / dur;
}

/** Fixed per-token vesting parameters (baked into the lock script by silverc). */
export type VestingParams = {
  creatorIdentifier: string; // x-only pubkey hex (the only allowed recipient)
  total: number;             // dev allocation locked
  startScore: number;        // vesting start (tx.locktime units)
  durationScore: number;     // linear release length
};
export type VestingTemplate = { script: Uint8Array; stateStart: number; stateLen: number; params: VestingParams };

// --- state splice (off `stateStart`, 9 bytes): 0x08 <claimed:8 LE> -----------------------------
export function materializeVestingScript(tpl: VestingTemplate, claimed: bigint): Uint8Array {
  const s = tpl.stateStart;
  const t = tpl.script;
  if (t[s] !== 0x08) throw new Error('vesting template has an unexpected state layout (expected push8 claimed)');
  if (claimed < 0n) throw new Error('claimed must be non-negative');
  const out = t.slice();
  out[s] = 0x08;
  out.set(int8LE(claimed), s + 1);
  return out;
}

export const vestingSpk = (k: K, redeem: Uint8Array): Spk => (k as any).payToScriptHashScript(redeem);
export const vestingSpkForState = (k: K, tpl: VestingTemplate, claimed: bigint): Spk => vestingSpk(k, materializeVestingScript(tpl, claimed));

export type VestUtxo = { transactionId: string; index: number; value: bigint };

/**
 * Partial claim: release `release` (0 < release < remaining) to the creator's presence, re-lock the rest under
 * V. inputs [vesting(0), lockedToken(1)]; outputs [vesting cont(0), relock(1, A/V-owned), recipient(2, A/creator)].
 * The flow must set tx.lockTime = current DAA score (consensus blocks the tx until then; the covenant reads it).
 *
 * Pass `opts.tokenCovid` (the vested token's covenant id, hex — `covenantId` from the indexer) so the relock +
 * recipient outputs carry the KIP-20 covenant binding the chain requires; without it the assembled tx fails
 * on-chain. The vesting-continuation output is always bound to `vestingCovid` (already a required param).
 */
export function buildVestingClaim(
  k: K,
  vestTpl: VestingTemplate,
  tokenTpl: Kcc20Template,
  vestingUtxo: VestUtxo,
  lockedToken: VestUtxo,
  vestingCovid: Uint8Array,
  creatorPubkey: Uint8Array,
  claimed: bigint,
  release: bigint,
  opts: { tokenDust?: bigint; tokenCovid?: string } = {},
): CovenantSpend {
  if (!opts.tokenCovid) throw new Error('opts.tokenCovid is required (the vested token covenant id, hex) — the relock + recipient outputs need the KIP-20 covenant binding or the tx fails on-chain');
  const total = BigInt(vestTpl.params.total);
  if (claimed < 0n || claimed >= total) throw new Error('nothing left to claim');
  const remaining = total - claimed;
  if (release <= 0n || release >= remaining) throw new Error('partial claim must be > 0 and < remaining (use claimFinal to drain)');
  const dust = opts.tokenDust ?? 1000n;
  const vestingCovidHex = hexOf(vestingCovid);
  const tokenBinding = opts.tokenCovid ? { covid: opts.tokenCovid, authorizingInput: 1 } : undefined;
  const newClaimed = claimed + release, newRemaining = remaining - release;

  const curRedeem = materializeVestingScript(vestTpl, claimed);
  const newRedeem = materializeVestingScript(vestTpl, newClaimed);
  const lockedState: Kcc20State = covenantIdOwned(vestingCovid, remaining, false);
  const relockState: Kcc20State = covenantIdOwned(vestingCovid, newRemaining, false);
  const recipientState: Kcc20State = addressPresenceOwned(creatorPubkey, release);
  const lockedRedeem = materializeKcc20Script(tokenTpl, lockedState);

  const b = new SigScriptBuilder(k).int(release);
  pushKcc20StateScalar(b, relockState);
  pushKcc20StateScalar(b, recipientState);
  const claimSig = b.selector(VEST_SELECTOR.claim).redeem(curRedeem).drain();

  const inputs: CovInput[] = [
    { transactionId: vestingUtxo.transactionId, index: vestingUtxo.index, value: vestingUtxo.value, scriptPublicKey: vestingSpk(k, curRedeem), signatureScript: claimSig, redeem: curRedeem, role: 'vesting' },
    { transactionId: lockedToken.transactionId, index: lockedToken.index, value: lockedToken.value, scriptPublicKey: kcc20Spk(k, lockedRedeem), signatureScript: transferSigScript(k, lockedRedeem, [relockState, recipientState], [0]), redeem: lockedRedeem, role: 'lockedToken' },
  ];
  const outputs: CovOutput[] = [
    { value: vestingUtxo.value, scriptPublicKey: vestingSpk(k, newRedeem), role: 'vesting', binding: { covid: vestingCovidHex, authorizingInput: 0 } },        // V continuation (claimed bumped)
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, relockState)), role: 'relock', binding: tokenBinding },    // re-locked (A, V-owned)
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, recipientState)), role: 'recipient', binding: tokenBinding }, // to creator (A, presence)
  ];
  return { kind: 'claim', inputs, outputs, economics: { release, newClaimed }, covids: opts.tokenCovid ? { tokenCovid: opts.tokenCovid } : {} };
}

/** Final claim: once fully vested, pay ALL remaining to the creator and continue V with claimed=total (husk).
 *  inputs [vesting(0), lockedToken(1)]; outputs [vesting cont(0), recipient(1, A/creator)].
 *
 *  Pass `opts.tokenCovid` (the vested token's covenant id, hex) so the recipient output carries the KIP-20
 *  covenant binding the chain requires; without it the assembled tx fails on-chain. */
export function buildVestingClaimFinal(
  k: K,
  vestTpl: VestingTemplate,
  tokenTpl: Kcc20Template,
  vestingUtxo: VestUtxo,
  lockedToken: VestUtxo,
  vestingCovid: Uint8Array,
  creatorPubkey: Uint8Array,
  claimed: bigint,
  opts: { tokenDust?: bigint; tokenCovid?: string } = {},
): CovenantSpend {
  if (!opts.tokenCovid) throw new Error('opts.tokenCovid is required (the vested token covenant id, hex) — the recipient output needs the KIP-20 covenant binding or the tx fails on-chain');
  const total = BigInt(vestTpl.params.total);
  if (claimed < 0n || claimed >= total) throw new Error('nothing left to claim');
  const remaining = total - claimed;
  const dust = opts.tokenDust ?? 1000n;
  const vestingCovidHex = hexOf(vestingCovid);
  const tokenBinding = opts.tokenCovid ? { covid: opts.tokenCovid, authorizingInput: 1 } : undefined;

  const curRedeem = materializeVestingScript(vestTpl, claimed);
  const newRedeem = materializeVestingScript(vestTpl, total);            // husk: fully claimed
  const lockedState: Kcc20State = covenantIdOwned(vestingCovid, remaining, false);
  const recipientState: Kcc20State = addressPresenceOwned(creatorPubkey, remaining);
  const lockedRedeem = materializeKcc20Script(tokenTpl, lockedState);

  const b = new SigScriptBuilder(k);
  pushKcc20StateScalar(b, recipientState);
  const claimSig = b.selector(VEST_SELECTOR.claimFinal).redeem(curRedeem).drain();

  const inputs: CovInput[] = [
    { transactionId: vestingUtxo.transactionId, index: vestingUtxo.index, value: vestingUtxo.value, scriptPublicKey: vestingSpk(k, curRedeem), signatureScript: claimSig, redeem: curRedeem, role: 'vesting' },
    { transactionId: lockedToken.transactionId, index: lockedToken.index, value: lockedToken.value, scriptPublicKey: kcc20Spk(k, lockedRedeem), signatureScript: transferSigScript(k, lockedRedeem, [recipientState], [0]), redeem: lockedRedeem, role: 'lockedToken' },
  ];
  const outputs: CovOutput[] = [
    { value: vestingUtxo.value, scriptPublicKey: vestingSpk(k, newRedeem), role: 'vesting', binding: { covid: vestingCovidHex, authorizingInput: 0 } },
    { value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tokenTpl, recipientState)), role: 'recipient', binding: tokenBinding },
  ];
  return { kind: 'claimFinal', inputs, outputs, economics: { release: remaining }, covids: opts.tokenCovid ? { tokenCovid: opts.tokenCovid } : {} };
}
