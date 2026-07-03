// KCC-20 native covenant-token transaction builder — wires kcc20.sil into Kaspa transactions. NO rollup.
//
// A token balance is a covenant P2SH UTXO whose redeem script carries a fixed-width 46-byte state region:
//   off 0 : 0x20 <ownerIdentifier:32>   off 33: 0x01 <identifierType:1>
//   off 35: 0x08 <amount: 8-byte LE>     off 44: 0x01 <isMinter:1>
// Everything outside the region is identical for a given (maxIns,maxOuts), so a new-balance redeem script
// is produced by SPLICING — no recompile at spend time.
//
// `transfer(State[] newStates, sig[] sigs, byte[] witnesses)` is the single entrypoint (no selector). It
// authorizes each covenant input by its ownership mode, validates each output's state via the covenant-id
// group, and enforces conservation unless the active branch isMinter (mint/burn). The curve & pool own
// token balances by COVENANT-ID (mode 0x02, no signature), which is what makes atomic mint/swap possible.
//
// No top-level SDK import (only `import type`) — caller passes the loaded WASM namespace `k`.
import type { Kaspa } from '../wasm/kaspa.types.js';
import type { CovInput, CovOutput, CovenantSpend } from './spend.js';
import { SigScriptBuilder, int8LE } from './sigscript.js';

type K = Kaspa;
type Spk = any;

/** kcc20 identifierType (ownership mode) values — dispatched by `transfer`'s checkSigs. */
export const IDENTIFIER = { PUBKEY: 0, SCRIPT_HASH: 1, COVENANT_ID: 2, ADDRESS: 3 } as const;
export type IdentifierType = (typeof IDENTIFIER)[keyof typeof IDENTIFIER];

/** A kcc20 token balance's full state (the 4 reference fields). `ownerIdentifier` is 32 bytes. */
export type Kcc20State = {
  ownerIdentifier: Uint8Array;
  identifierType: IdentifierType;
  amount: bigint;
  isMinter: boolean;
};

/** Compiled token template: silverc output at the genesis state + the (maxIns,maxOuts) it was built for. */
export type Kcc20Template = { script: Uint8Array; stateStart: number; maxIns: number; maxOuts: number };

const STATE_LEN = 46;

// --- redeem-script materialization (the 46-byte state splice) -----------------------------------

/** Produce the kcc20 redeem script for `state` by splicing the 46-byte region. Byte-identical to silverc. */
export function materializeKcc20Script(tpl: Kcc20Template, state: Kcc20State): Uint8Array {
  const s = tpl.stateStart;
  const t = tpl.script;
  if (t[s] !== 0x20 || t[s + 33] !== 0x01 || t[s + 35] !== 0x08 || t[s + 44] !== 0x01) {
    throw new Error('kcc20 template has an unexpected state layout (expected push32 owner / push1 type / push8 amount / push1 isMinter)');
  }
  if (state.ownerIdentifier.length !== 32) throw new Error('ownerIdentifier must be 32 bytes');
  if (state.amount < 0n) throw new Error('amount must be non-negative');
  const out = t.slice();
  out[s] = 0x20;
  out.set(state.ownerIdentifier, s + 1);
  out[s + 33] = 0x01;
  out[s + 34] = state.identifierType;
  out[s + 35] = 0x08;
  out.set(int8LE(state.amount), s + 36);
  out[s + 44] = 0x01;
  out[s + 45] = state.isMinter ? 1 : 0;
  return out;
}

// --- redeem-script decode (template + state from a live UTXO's redeemScriptHex) ------------------

/**
 * Recover the `{ script, stateStart }` template AND the current balance state from a live token UTXO's
 * redeem script (your indexer's `redeemScriptHex`). Scans for the 46-byte state region's push layout
 * (`0x20 <owner:32> 0x01 <type:1> 0x08 <amount:8> 0x01 <isMinter:1>` with type ≤ 0x03, isMinter ≤ 1) and
 * requires it to match at exactly ONE offset. This is the supported way to build the template for
 * `materializeKcc20Script` — splice the SAME script the chain holds; never re-compile.
 * `maxIns`/`maxOuts` are compiled constants not recoverable from the bytes — pass the token's deploy
 * params if you know them (KRON deploys use 4/4, the default) — they are informational only (the splice
 * uses just `script` + `stateStart`).
 */
export function decodeKcc20Redeem(redeem: Uint8Array, opts: { maxIns?: number; maxOuts?: number } = {}): { template: Kcc20Template; state: Kcc20State } {
  const hits: number[] = [];
  for (let s = 0; s + STATE_LEN <= redeem.length; s++) {
    if (redeem[s] === 0x20 && redeem[s + 33] === 0x01 && redeem[s + 34] <= 0x03 && redeem[s + 35] === 0x08 && redeem[s + 44] === 0x01 && redeem[s + 45] <= 1) hits.push(s);
  }
  if (hits.length !== 1) throw new Error(`could not locate the kcc20 state region in the redeem script (${hits.length} candidate offsets) — is this a kcc20 token UTXO?`);
  const s = hits[0];
  let amount = 0n;
  for (let i = 7; i >= 0; i--) amount = (amount << 8n) | BigInt(redeem[s + 36 + i]);
  return {
    template: { script: redeem.slice(), stateStart: s, maxIns: opts.maxIns ?? 4, maxOuts: opts.maxOuts ?? 4 },
    state: {
      ownerIdentifier: redeem.slice(s + 1, s + 33),
      identifierType: redeem[s + 34] as IdentifierType,
      amount,
      isMinter: redeem[s + 45] === 1,
    },
  };
}

// --- scriptPublicKeys + address ----------------------------------------------------------------

/** Token P2SH scriptPublicKey for a redeem script. */
export const kcc20Spk = (k: K, redeem: Uint8Array): Spk => (k as any).payToScriptHashScript(redeem);

/** Token P2SH scriptPublicKey for a balance state (materialize → P2SH). */
export const kcc20SpkForState = (k: K, tpl: Kcc20Template, state: Kcc20State): Spk =>
  kcc20Spk(k, materializeKcc20Script(tpl, state));

/** Token P2SH address (where this balance lives) for a balance state. */
export function kcc20Address(k: K, tpl: Kcc20Template, state: Kcc20State, network: string): string {
  return (k as any).addressFromScriptPublicKey(kcc20SpkForState(k, tpl, state), network)?.toString() ?? '';
}

// --- ownership-mode constructors ---------------------------------------------------------------

/** A balance owned by a covenant-id `C` (mode 0x02): spendable only in a tx that also spends an input
 *  carrying `C`. This is how the curve owns its minter branch and the pool owns its token UTXO. */
export const covenantIdOwned = (covid32: Uint8Array, amount: bigint, isMinter = false): Kcc20State => ({
  ownerIdentifier: covid32,
  identifierType: IDENTIFIER.COVENANT_ID,
  amount,
  isMinter,
});

/** A balance owned by a 32-byte x-only pubkey (mode 0x00): a user's normal holding (needs a signature). */
export const pubkeyOwned = (pubkey32: Uint8Array, amount: bigint): Kcc20State => ({
  ownerIdentifier: pubkey32,
  identifierType: IDENTIFIER.PUBKEY,
  amount,
  isMinter: false,
});

/** A balance owned by a 32-byte P2SH script-hash (mode 0x01): needs a matching P2SH input in the tx. */
export const scriptHashOwned = (hash32: Uint8Array, amount: bigint): Kcc20State => ({
  ownerIdentifier: hash32,
  identifierType: IDENTIFIER.SCRIPT_HASH,
  amount,
  isMinter: false,
});

/** A balance owned by a normal ADDRESS (mode 0x03, presence-based): spendable when the tx carries a
 *  co-present input at the owner's P2PK address (a wallet-signed input). The token UTXO itself carries NO
 *  signature, so sell/transfer work with existing wallets via a signPskt-style bridge. owner = x-only pubkey. */
export const addressPresenceOwned = (pubkey32: Uint8Array, amount: bigint): Kcc20State => ({
  ownerIdentifier: pubkey32,
  identifierType: IDENTIFIER.ADDRESS,
  amount,
  isMinter: false,
});

// --- transfer signature script (the column-major State[] ABI) -----------------------------------

/** Push a SINGLE `State`/`TokenState` struct arg field-by-field (declared order, scalar rules) — used by
 *  entrypoints whose covenant takes individual structs (e.g. curve buy/sell/graduate, pool swap). */
export function pushKcc20StateScalar(b: SigScriptBuilder, st: Kcc20State): void {
  if (st.ownerIdentifier.length !== 32) throw new Error('ownerIdentifier must be 32 bytes');
  b.data(st.ownerIdentifier).byte(st.identifierType).int(st.amount).bool(st.isMinter);
}

/** Push a `State[]` arg column-major (owners ‖ types ‖ amounts ‖ isMinters), per build_sig_script. */
export function pushKcc20States(b: SigScriptBuilder, states: Kcc20State[]): void {
  for (const st of states) if (st.ownerIdentifier.length !== 32) throw new Error('ownerIdentifier must be 32 bytes');
  b.column(states.map((s) => s.ownerIdentifier)); // byte[32][] column
  b.column(states.map((s) => Uint8Array.of(s.identifierType))); // byte[] column
  b.column(states.map((s) => int8LE(s.amount))); // int[] column (8-byte LE each)
  b.column(states.map((s) => Uint8Array.of(s.isMinter ? 1 : 0))); // bool[] column
}

/**
 * Build the kcc20 `transfer` signature script for a token covenant input:
 *   <newStates column-major> <sigs> <witnesses> <redeem>   (single entrypoint → no selector)
 * `witnesses[i]` is the tx-input index that authorizes input i (for covenant-id ownership, the input
 * carrying that covenant id). `sigs` are 65-byte Schnorr sigs (empty for covenant-id-only ownership).
 */
export function transferSigScript(
  k: K,
  redeem: Uint8Array,
  newStates: Kcc20State[],
  witnesses: number[],
  sigs: Uint8Array[] = [],
): string {
  if (newStates.length < 1) throw new Error('transfer requires at least one output state');
  const b = new SigScriptBuilder(k);
  pushKcc20States(b, newStates);
  b.column(sigs); // sig[] — fixed-width concat (empty → empty push)
  b.data(Uint8Array.from(witnesses, (w) => w & 0xff)); // byte[] witnesses
  b.redeem(redeem);
  return b.drain();
}

// --- send (wallet "Send" — the plain user→user transfer) ----------------------------------------

/**
 * Send `sendAmount` from one or more presence-owned token UTXOs (same owner) to `recipientPubkey32`, with
 * the remainder returned to the sender — the wallet "Send" button. A plain conserving `transfer`: inputs
 * are authorized by ONE co-present P2PK input at tx index `presenceWitnessIdx` (assemble the covenant
 * inputs first, then the sender's funding inputs: with N token inputs, `presenceWitnessIdx = N`).
 *
 * `tokenCovid` (the token's covenant id, hex — `covenantId` from the indexer's token info) is REQUIRED:
 * every covenant output must carry the KIP-20 `CovenantBinding` or the chain rejects the spend with
 * "script ran, but verification failed". Outputs: [recipient, change] (change omitted when exact).
 */
export function buildKcc20Send(
  k: K, tpl: Kcc20Template,
  senderTokens: { transactionId: string; index: number; value: bigint; state: Kcc20State }[],
  recipientPubkey32: Uint8Array, sendAmount: bigint, presenceWitnessIdx: number, tokenCovid: string,
  opts: { tokenDust?: bigint } = {},
): CovenantSpend {
  if (senderTokens.length < 1) throw new Error('send requires at least one token UTXO');
  if (!tokenCovid) throw new Error('send requires the token covenant id (indexer token info `covenantId`) for the output bindings');
  const total = senderTokens.reduce((s, t) => s + t.state.amount, 0n);
  const change = total - sendAmount;
  if (sendAmount < 1n || change < 0n) throw new Error(`send requires 1 <= sendAmount <= ${total} (the selected UTXOs' total)`);
  const dust = opts.tokenDust ?? 50_000_000n; // COVENANT_DUST — KIP-9 storage-mass floor for covenant outputs
  const owner = senderTokens[0].state.ownerIdentifier;
  const recipientOut = addressPresenceOwned(recipientPubkey32, sendAmount);
  const newStates = change >= 1n ? [recipientOut, addressPresenceOwned(owner, change)] : [recipientOut];
  const witnesses = senderTokens.map(() => presenceWitnessIdx); // every token input authorized by the one P2PK
  const inputs: CovInput[] = senderTokens.map((t) => {
    const r = materializeKcc20Script(tpl, t.state);
    return { transactionId: t.transactionId, index: t.index, value: t.value, scriptPublicKey: kcc20Spk(k, r), signatureScript: transferSigScript(k, r, newStates, witnesses), redeem: r, role: 'token' };
  });
  const binding = { covid: tokenCovid, authorizingInput: 0 }; // ← the first token input carries covid A
  const outputs: CovOutput[] = newStates.map((st, i) => ({
    value: dust, scriptPublicKey: kcc20Spk(k, materializeKcc20Script(tpl, st)), role: i === 0 ? 'send' : 'change', binding,
  }));
  return { kind: 'transfer', inputs, outputs, economics: { sendAmount, change }, covids: { tokenCovid } };
}
