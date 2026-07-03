#!/usr/bin/env node
/**
 * example-kcc20-send.mjs — runnable end-to-end KCC-20 "Send": transfer tokens from your key's address to a
 * recipient, on-chain (TN10). This is the reference for INTEGRATION.md §5 "Transfers (wallet Send)".
 *
 * The three things a working transfer needs BEYOND the signature script (all handled by the SDK here):
 *   1. tx.version = 1               — covenant outputs only exist in KIP-20 v1 transactions
 *   2. CovenantBinding on outputs   — token outputs must join the token's covenant-id group, or the
 *                                     covenant's OpCovOutputCount check fails on-chain with
 *                                     "script ran, but verification failed"
 *   3. computeBudget per input      — v1 execution metering (P2PK ≈ 10, kcc20 input ≈ 500); the fee must
 *                                     cover it (estimateNativeFee), a flat legacy fee is too low
 *
 * Usage:
 *   KRON_INDEXER=https://idx.kron.technology/v1/kcc20 \
 *   KASPA_WRPC=wss://node.kron.technology \
 *   NETWORK_ID=testnet-10 \
 *   TICK=kron \
 *   SEND_TO=kaspatest:qq... \
 *   SEND_AMOUNT=3 \
 *   PRIVKEY=<hex> \
 *   node scripts/example-kcc20-send.mjs
 *
 * PRIVKEY's address must hold the tokens AND the KAS that funds the tx. SEND_TO is a schnorr P2PK address.
 */
import * as kron from '../dist/index.js';
import { loadKaspa } from '../dist/wasm/index.node.js';

const env = (n, d) => process.env[n] ?? d ?? (() => { throw new Error(`missing env ${n}`); })();
const INDEXER = env('KRON_INDEXER', 'https://idx.kron.technology/v1/kcc20');
const WRPC = env('KASPA_WRPC', 'wss://node.kron.technology');
const NETWORK_ID = env('NETWORK_ID', 'testnet-10');
const TICK = env('TICK');
const SEND_TO = env('SEND_TO');
const SEND_AMOUNT = BigInt(env('SEND_AMOUNT'));
const PRIVKEY = env('PRIVKEY');

const hexToBytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

const k = await loadKaspa();
const key = new k.PrivateKey(PRIVKEY);
const networkType = NETWORK_ID.startsWith('mainnet') ? k.NetworkType.Mainnet : k.NetworkType.Testnet;
const senderAddr = key.toPublicKey().toAddress(networkType).toString();
const recipientPub32 = hexToBytes(k.XOnlyPublicKey.fromAddress(new k.Address(SEND_TO)).toString());

// 1. Token info (for the covenant id — the outputs' binding target) + the sender's token UTXOs.
const indexer = new kron.client.IndexerClient(INDEXER);
const info = await indexer.token(TICK);
const tokenCovid = info.covenantId;
const utxos = await indexer.tokenUtxos(TICK, senderAddr);
if (!utxos.length) throw new Error(`no ${TICK} UTXOs at ${senderAddr}`);

// 2. Decode each UTXO's redeem script → { template, state } (splice the SAME script the chain holds).
const decoded = utxos.map((u) => ({ utxo: u, ...kron.kcc20.decodeKcc20Redeem(hexToBytes(u.redeemScriptHex)) }));
if (decoded.some((d) => d.state.identifierType !== kron.kcc20.IDENTIFIER.ADDRESS)) throw new Error('expected presence-owned (ADDRESS-mode) token UTXOs');
// pick the fewest largest pieces covering the send (the covenant's maxIns bounds how many fit in one tx)
decoded.sort((a, b) => (a.state.amount < b.state.amount ? 1 : -1));
const picked = [];
let covered = 0n;
for (const d of decoded) { picked.push(d); covered += d.state.amount; if (covered >= SEND_AMOUNT) break; }
if (covered < SEND_AMOUNT) throw new Error(`balance ${covered} < send amount ${SEND_AMOUNT}`);
if (picked.length > picked[0].template.maxIns) throw new Error('too many pieces for one tx — consolidate first (kron.curveCp.buildConsolidate)');

// 3. Build the transfer: [recipient, change], all inputs authorized by the co-present P2PK at index N.
//    Token UTXOs are created carrying the 0.5-KAS covenant dust; if your deploy differs, read the real
//    sompi value from the node's UTXO set for the token's P2SH address.
const senderTokens = picked.map((d) => ({
  transactionId: d.utxo.outpoint.transactionId, index: d.utxo.outpoint.index,
  value: kron.spend.COVENANT_DUST,
  state: d.state,
}));
const presenceWitnessIdx = senderTokens.length; // [token 0..N-1, funding[0] = N]
const spend = kron.kcc20.buildKcc20Send(k, picked[0].template, senderTokens, recipientPub32, SEND_AMOUNT, presenceWitnessIdx, tokenCovid);

// 4. Funding + assembly (v1 tx, covenant bindings, compute budgets) + fee sizing + signing.
const rpc = new k.RpcClient({ url: WRPC, networkId: NETWORK_ID, encoding: k.Encoding.Borsh });
await rpc.connect();
try {
  const { entries } = await rpc.getUtxosByAddresses({ addresses: [senderAddr] });
  const fundingEntries = entries.sort((a, b) => Number(BigInt(b.amount) - BigInt(a.amount))).slice(0, 1);
  let asm = kron.spend.assembleNativeTx(k, { spend, fundingEntries, changeAddress: senderAddr, networkFee: 10_000n });
  const fee = kron.spend.estimateNativeFee(k, NETWORK_ID, asm, 100);
  asm = kron.spend.assembleNativeTx(k, { spend, fundingEntries, changeAddress: senderAddr, networkFee: fee });
  kron.spend.signFundingInputs(k, asm.transaction, key, asm.fundingInputIndexes);

  // 5. Submit.
  const { transactionId } = await rpc.submitTransaction({ transaction: asm.transaction });
  console.log(`sent ${SEND_AMOUNT} ${TICK.toUpperCase()} -> ${SEND_TO}`);
  console.log(`txid ${transactionId} (fee ${fee} sompi)`);
} finally {
  await rpc.disconnect();
}
