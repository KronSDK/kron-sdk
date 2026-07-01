// KIP-20 genesis covenant-id (the native track's identity primitive). A covenant-id `A` is assigned by
// consensus when a covenant UTXO is first created ("genesis"): it is a CovenantID-keyed blake2b-256 over
// the spending tx's first-input outpoint and the set of authorized outputs (see
// rusty-kaspa/consensus/core/src/hashing/covenant_id.rs). A forged id raises WrongGenesisCovenantId.
//
// The vendored Kaspa WASM SDK already ships the consensus implementation as `covenantId(...)`, so we wrap
// it rather than re-deriving the keyed blake2b. ONE non-obvious gotcha (cost real time to find upstream):
// the SDK's `covenantId` only matches consensus when each authorized output's `scriptPublicKey` is passed
// as a {version, script} object (or a ScriptPublicKey instance) — a BARE HEX STRING silently produces a
// wrong id. `payToScriptHashScript()` returns a ScriptPublicKey instance, so pass that straight through.
//
// No top-level SDK import (only `import type`) so this runs in the browser (caller passes the loaded `k`)
// and under Node. Returns/consumes covenant-ids as 32-byte big-endian hex (no 0x), the shape used across the
// native builders and the indexer API.
import type { Kaspa } from '../wasm/kaspa.types.js';

type K = Kaspa;
/** SDK ScriptPublicKey instance, or a plain {version, script-hex} object. Kept loose, matching SDK style. */
type Spk = any;

/** The genesis outpoint = the spending tx's FIRST input outpoint (`tx.inputs[0]`). */
export type GenesisOutpoint = { transactionId: string; index: number };

/** An output the genesis outpoint authorizes for covenant-id derivation (its index + the output itself). */
export type AuthOutput = { index: number; value: bigint; scriptPublicKey: Spk };

const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));
const bytesToHex = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Compute the KIP-20 genesis covenant-id (32-byte hex, no 0x) for a covenant UTXO created by a tx whose
 * first input is `genesisOutpoint` and whose authorized outputs are `authOutputs`. Byte-exact with
 * consensus. Used to:
 *  - bind the curve `C` ↔ its token `A` (curve_cp `init`),
 *  - pre-compute the pool covenant-id `P` a graduation will assign,
 *  - derive a freshly-created covenant's own id client-side before broadcast.
 */
export function genesisCovenantId(k: K, genesisOutpoint: GenesisOutpoint, authOutputs: AuthOutput[]): string {
  const auth = authOutputs.map((o) => ({
    index: o.index,
    // Normalize to a plain { version, script-hex } object — the form the SDK serializes to match consensus.
    // A bare hex string OR a ScriptPublicKey *instance* both yield a (different) wrong id; only this works.
    output: { value: o.value, scriptPublicKey: { version: o.scriptPublicKey.version ?? 0, script: o.scriptPublicKey.script ?? o.scriptPublicKey } },
  }));
  return (k as any).covenantId(genesisOutpoint, auth).toString();
}

/** Covenant-ids are byte[32] in the covenants; convert between the hex form and bytes for state encoding. */
export const covidToBytes = (covidHex: string): Uint8Array => hexToBytes(covidHex);
export const bytesToCovid = (u8: Uint8Array): string => bytesToHex(u8);

/** The all-zero covenant-id placeholder (a curve's `tokenCovid` before `init` binds it; ZERO_COVID). */
export const ZERO_COVID = '00'.repeat(32);
