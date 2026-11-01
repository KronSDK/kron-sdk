// kcc20v1 (KCC-20 standard) family — a holder's plain token transfer (send / split), no curve or pool involved
// (docs/kcc20v1/PLAN.md §5 "send, split flows"; the 1-input transfer and the 2-piece shapes of the G0.3 wallet matrix).
// The holder's FIRST piece is the KCC-20 LEADER: `transfer(next_states, 00 ‖ authority)` declares every successor — the
// recipient's new piece (rule 3: p2pk-schnorr, borrow disabled, zero guard, the piece's extension) and, when the amount
// does not use the whole input, the holder's change piece (rule 4: a copy of the holder's own settings). Further pieces of
// the same holder are DELEGATORS (`transfer_delegator(authority)`), at most MAX_TRANSFER_PIECES in all. Every token output is
// COVENANT_DUST; a P2PK funding input pays the dust and the fee. The wallet signs the funding input and every holder piece.
import type { Kaspa } from '../wasm/kaspa.types.js';
import { type Kcc20V1State, type Kcc20V1Template, OWNER_SCHEME, assertHolderPieceV1, authorityV1, changeLikeV1, kcc20V1Spk, leaderWitnessV1, materializeKcc20V1Script, p2pkOwnedV1, SIG65_PLACEHOLDER, transferDelegatorSigScriptV1, transferSigScriptV1 } from './kcc20V1Tx.js';
import { type CovInputV1, type CovOutputV1, type CovenantSpendV1, TOKEN_V1_COMPUTE } from './covenantTxKcc20V1.js';
import type { TokenUtxoV1, Blake3 } from './curveKcc20Tx.js';
import { hexOf } from './dispatchTag.js';

type K = Kaspa;
export const COVENANT_DUST_V1 = 50_000_000n;
export const MAX_TRANSFER_PIECES = 2; // the reference token's own bound: 1 leader + 2 delegates would be 3 inputs; KRON sends with ≤ 2 (merges ≤ 2, §4 rule 7)
const noBlake3: Blake3 = () => { throw new Error('p2pkh-schnorr holder pieces need a blake3 implementation'); };
const outpoint = (u: { transactionId: string; index: number }) => ({ transactionId: u.transactionId, index: u.index });

/**
 * Transfer `amount` of the holder's pieces to `recipientPubkey` (x-only, 32 bytes). `pieces` are the holder's own token
 * UTXOs (1..MAX_TRANSFER_PIECES, all the same owner); a change piece is created when they hold more than `amount`.
 * Inputs: [leader piece, delegator pieces…] — the funding input is appended by assembleFamilyTx. Outputs: [recipient piece,
 * (change piece)]. The recipient's piece is authorized by the leader (CovenantBinding input 0).
 */
export function buildTokenTransferV1(k: K, tpl: Kcc20V1Template, tokenCovid: Uint8Array, pieces: TokenUtxoV1[], holderPubkey: Uint8Array, recipientPubkey: Uint8Array, amount: bigint, opts: { tokenDust?: bigint; blake3?: Blake3 } = {}): CovenantSpendV1 {
  if (pieces.length < 1 || pieces.length > MAX_TRANSFER_PIECES) throw new Error(`a transfer spends 1..${MAX_TRANSFER_PIECES} of the holder's pieces`);
  if (recipientPubkey.length !== 32) throw new Error('recipient must be a 32-byte x-only pubkey');
  if (amount <= 0n) throw new Error('amount must be positive');
  const dust = opts.tokenDust ?? COVENANT_DUST_V1, blake3Of = opts.blake3 ?? noBlake3;
  for (const p of pieces) assertHolderPieceV1(p.state, holderPubkey, blake3Of);
  const total = pieces.reduce((s, p) => s + p.state.amount, 0n);
  if (amount > total) throw new Error(`the pieces hold ${total}, less than the ${amount} to transfer`);
  const first = pieces[0].state, ext = first.extensionCommitment;
  const recipient = p2pkOwnedV1(recipientPubkey, amount, ext);
  const change = total - amount;
  const nextStates: Kcc20V1State[] = change > 0n ? [recipient, changeLikeV1(first, change, ext)] : [recipient];
  const leaderRedeem = materializeKcc20V1Script(tpl, first);
  const leaderWith = (sig65: Uint8Array) => transferSigScriptV1(k, tpl, leaderRedeem, nextStates, leaderWitnessV1(authorityV1(first, sig65, holderPubkey)));
  const inputs: CovInputV1[] = [{
    ...outpoint(pieces[0]), value: pieces[0].value, scriptPublicKey: kcc20V1Spk(k, leaderRedeem), redeem: leaderRedeem, covid: hexOf(tokenCovid), role: 'holderLeader', computeBudget: TOKEN_V1_COMPUTE,
    signatureScript: leaderWith(SIG65_PLACEHOLDER), invocation: { program: 'token', entry: 'transfer', args: [nextStates, leaderWitnessV1(authorityV1(first, SIG65_PLACEHOLDER, holderPubkey))] },
    sign: { holderPubkey, ownerScheme: first.ownerScheme, withSignature: leaderWith },
  }];
  for (const piece of pieces.slice(1)) {
    const redeem = materializeKcc20V1Script(tpl, piece.state);
    const withSignature = (sig65: Uint8Array) => transferDelegatorSigScriptV1(k, tpl, redeem, authorityV1(piece.state, sig65, holderPubkey));
    inputs.push({ ...outpoint(piece), value: piece.value, scriptPublicKey: kcc20V1Spk(k, redeem), redeem, covid: hexOf(tokenCovid), role: 'holderDelegator', computeBudget: TOKEN_V1_COMPUTE, signatureScript: withSignature(SIG65_PLACEHOLDER), invocation: { program: 'token', entry: 'transfer_delegator', args: [authorityV1(piece.state, SIG65_PLACEHOLDER, holderPubkey)] }, sign: { holderPubkey, ownerScheme: piece.state.ownerScheme, withSignature } });
  }
  const outputs: CovOutputV1[] = nextStates.map((s, i) => ({ value: dust, scriptPublicKey: kcc20V1Spk(k, materializeKcc20V1Script(tpl, s)), role: i === 0 ? 'recipient' : 'change', covenant: { covid: hexOf(tokenCovid), authorizingInput: 0 } }));
  return { family: 'kcc20v1', kind: 'transfer', inputs, outputs, economics: { amount, change, pieces: BigInt(pieces.length) }, covids: { tokenCovid: hexOf(tokenCovid) } };
}
export { OWNER_SCHEME };
