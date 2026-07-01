// Offline end-to-end sanity check (no network, no funds, no compiler): exercises the builder chain this
// package actually ships — quote math, state-splicing, tx assembly, and the wallet-signing bridge — against
// an ALREADY-DEPLOYED curve (represented here by a synthetic template, since this package doesn't compile
// or deploy new covenant instances; a real integration reads the target's actual compiled script bytes from
// the indexer instead). This is a smoke test for the ported TS logic, not a substitute for the private
// KRON repo's VM-verified test suite — see README "Verification".
import { randomBytes } from 'node:crypto';
import * as kron from '../dist/index.js';
import { loadKaspa } from '../dist/wasm/index.node.js';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

/** A structurally-valid (but not on-chain-real) script: some prefix bytes, the fixed-width state region
 *  materializeXScript expects at `stateStart`, some suffix bytes. Good enough to exercise the splice +
 *  assemble + sign pipeline; NOT a substitute for a real compiled script (this package doesn't ship a
 *  compiler — see README "Design notes"). */
function syntheticTemplate(stateLen, markers) {
  const prefix = randomBytes(12);
  const suffix = randomBytes(12);
  const state = new Uint8Array(stateLen);
  for (const [offset, value] of markers) state[offset] = value;
  const script = new Uint8Array(prefix.length + stateLen + suffix.length);
  script.set(prefix, 0);
  script.set(state, prefix.length);
  script.set(suffix, prefix.length + stateLen);
  return { script, stateStart: prefix.length };
}

async function main() {
  console.log('1. Loading Kaspa WASM SDK...');
  const k = await loadKaspa();
  console.log('   OK');

  console.log('2. Curve/pool/vesting quote math (pure, no template needed)...');
  const cpState = { realKas: 1000n, tokenReserve: 999_999_999n, vKas: 6_250_000n, graduationKas: 25_000_000_000_000n, creatorFeeBps: 25n, platformFeeBps: 100n };
  const buyQuote = kron.curve.quoteCpBuy(cpState, 10_000_000_000n);
  assert(buyQuote !== null && buyQuote.tokenOut > 0n, 'curve buy quote must succeed');
  const sellQuote = kron.curve.quoteCpSell({ ...cpState, realKas: cpState.realKas + buyQuote.kasIn, tokenReserve: cpState.tokenReserve - buyQuote.tokenOut }, buyQuote.tokenOut);
  assert(sellQuote !== null, 'curve sell quote must succeed on the post-buy state');
  const poolState = { kasReserve: 1_000_000n, tokenReserve: 999_999_999n, tokenCovid: new Uint8Array(32), totalShares: 1_000_000n, lpCovid: new Uint8Array(32) };
  const poolParams = { creatorFeeOwner: new Uint8Array(32), platformFeeOwner: new Uint8Array(32), creatorFeeBps: 10n, platformFeeBps: 5n, lpFeeBps: 20n, lockedShares: 1_000_000n };
  const poolBuyQ = kron.poolCp.quotePoolCpBuy(poolState, poolParams, 100_000_000n);
  assert(poolBuyQ !== null && poolBuyQ.tokenOut > 0n, 'pool buy quote must succeed');
  const vested = kron.vesting.vestedAmount(1000n, 0, 100, 50);
  assert(vested === 500n, `vestedAmount(1000,0,100,50) should be 500 (linear halfway), got ${vested}`);
  console.log('   OK — curve buy/sell, pool buy, vesting all quote correctly');

  console.log('3. Building a buy against a SYNTHETIC existing-curve template (structural test, not on-chain-real)...');
  const buyerKey = new k.PrivateKey(randomBytes(32).toString('hex'));
  const buyerPub = buyerKey.toPublicKey();
  const buyerXOnly = buyerPub.toString().replace(/^0x/, '').slice(-64);

  const tokenTplRaw = syntheticTemplate(46, [[0, 0x20], [33, 0x01], [35, 0x08], [44, 0x01]]);
  const tokenTpl = { ...tokenTplRaw, maxIns: 4, maxOuts: 4 };
  const cpTplRaw = syntheticTemplate(35, [[0, 0x01], [2, 0x20]]);
  const cpTpl = {
    ...cpTplRaw,
    params: {
      creatorFeeOwner: randomBytes(32), platformFeeOwner: randomBytes(32),
      vKas: cpState.vKas, graduationKas: cpState.graduationKas,
      creatorFeeBps: cpState.creatorFeeBps, platformFeeBps: cpState.platformFeeBps, graduationFeeBps: 500n,
    },
  };
  const curveCovid = randomBytes(32);
  const tokenCovid = randomBytes(32);
  const utxo = { transactionId: 'aa'.repeat(32), index: 0, realKas: cpState.realKas, state: { graduated: false, tokenCovid } };
  const inventory = { transactionId: 'aa'.repeat(32), index: 1, value: 1000n, amount: cpState.tokenReserve };

  const buySpend = kron.curveCp.buildCpBuy(k, cpTpl, tokenTpl, utxo, inventory, curveCovid, Uint8Array.from(Buffer.from(buyerXOnly, 'hex')), buyQuote.kasIn, buyQuote.tokenOut);
  assert(buySpend.economics.newTokenReserve === cpState.tokenReserve - buyQuote.tokenOut, 'buy must reduce inventory by exactly tokenOut');
  console.log('   OK —', buySpend.inputs.length, 'covenant inputs,', buySpend.outputs.length, 'covenant outputs');

  console.log('4. Full-tx assembly (spend.assembleNativeTx) + signPskt-style local signing...');
  const fundingEntry = {
    amount: 20_000_000_000n, // covers kasIn (~100 KAS) + fees + network fee
    outpoint: { transactionId: 'bb'.repeat(32), index: 0 },
    scriptPublicKey: k.payToAddressScript(buyerPub.toAddress(k.NetworkType.Testnet)),
    blockDaaScore: 0n, isCoinbase: false,
  };
  const asm = kron.spend.assembleNativeTx(k, { spend: buySpend, fundingEntries: [fundingEntry], changeAddress: buyerPub.toAddress(k.NetworkType.Testnet).toString(), networkFee: 5000n });
  assert(asm.fundingInputIndexes.length === 1, 'exactly one funding input expected');
  const pskt = kron.spend.toPsktJson(asm);
  const signed = kron.spend.signPsktWithKey(k, pskt.txJsonString, pskt.signInputs, buyerKey);
  const reparsed = k.Transaction.deserializeFromSafeJSON(signed);
  assert(reparsed.inputs[asm.fundingInputIndexes[0]].signatureScript.length > 0, 'the funding input must now carry a signature script');
  assert(reparsed.inputs[0].signatureScript === buySpend.inputs[0].signatureScript, 'covenant input 0 signature script must be UNTOUCHED by wallet signing — this is the core fund-safety property');
  console.log('   OK — signing touched ONLY the funding input, covenant inputs untouched');

  console.log('5. Token-list entry verification (verify.verifyTokenListEntry, injected stub fetcher)...');
  const covidA = 'a1'.repeat(32);
  const listEntry = {
    network: 'testnet-10', covenantId: covidA, symbol: 'GHOST', name: 'Ghost', decimals: 0,
    extensions: { curveCovenantId: 'c1'.repeat(32), poolCovenantId: null, genesisTxid: '11'.repeat(32), creator: null, creatorPubkey: null, curveParams: null, graduated: false, chainVerified: true },
  };
  // genesis tx that DOES create covid A (present as covenant_id on an output) -> ok
  const okRes = await kron.verify.verifyTokenListEntry(listEntry, async () => ({ outputs: [{ covenant_id: 'c1'.repeat(32) }, { covenant_id: covidA }] }));
  assert(okRes.ok === true, 'entry whose covid A is on its genesis tx must verify');
  // genesis tx that does NOT -> rejected with a reason, no throw
  const badRes = await kron.verify.verifyTokenListEntry(listEntry, async () => ({ outputs: [{ covenant_id: 'c1'.repeat(32) }] }));
  assert(badRes.ok === false && /not found/.test(badRes.reason), 'entry whose covid A is absent must be rejected');
  console.log('   OK — verifier accepts a genuine entry, rejects a spoofed one');

  console.log('\nALL OFFLINE FLOW CHECKS PASSED.');
}

main().catch((err) => {
  console.error('\nE2E FLOW FAILED:', err);
  process.exit(1);
});
