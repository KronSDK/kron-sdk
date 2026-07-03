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

const hexOf = (u8) => Buffer.from(u8).toString('hex');

/** Assert a CovOutput carries the KIP-20 CovenantBinding a builder is supposed to attach. */
function assertBinding(output, covidHex, authorizingInput, label) {
  assert(output.binding, `${label}: output must carry a covenant binding`);
  assert(output.binding.covid === covidHex, `${label}: binding covid mismatch (want ${covidHex}, got ${output.binding.covid})`);
  assert(output.binding.authorizingInput === authorizingInput, `${label}: binding authorizingInput mismatch (want ${authorizingInput}, got ${output.binding.authorizingInput})`);
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
  const cpTplRaw = syntheticTemplate(44, [[0, 0x01], [2, 0x20], [35, 0x08]]); // 44-byte hardened state: graduated + tokenCovid + tokenReserve
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
  const utxo = { transactionId: 'aa'.repeat(32), index: 0, realKas: cpState.realKas, state: { graduated: false, tokenCovid, tokenReserve: cpState.tokenReserve } };
  const inventory = { transactionId: 'aa'.repeat(32), index: 1, value: 1000n, amount: cpState.tokenReserve };

  const buySpend = kron.curveCp.buildCpBuy(k, cpTpl, tokenTpl, utxo, inventory, curveCovid, Uint8Array.from(Buffer.from(buyerXOnly, 'hex')), buyQuote.kasIn, buyQuote.tokenOut);
  assert(buySpend.economics.newTokenReserve === cpState.tokenReserve - buyQuote.tokenOut, 'buy must reduce inventory by exactly tokenOut');
  console.log('   OK —', buySpend.inputs.length, 'covenant inputs,', buySpend.outputs.length, 'covenant outputs');

  console.log('3b. Curve buy (buildCpBuy) output bindings: curve continuation (C) + inventory/recipient (A)...');
  const curveCovidHex = hexOf(curveCovid);
  const tokenCovidHex = hexOf(tokenCovid);
  assertBinding(buySpend.outputs[0], curveCovidHex, 0, 'buy curve continuation');
  assertBinding(buySpend.outputs[1], tokenCovidHex, 1, 'buy inventory');
  assertBinding(buySpend.outputs[2], tokenCovidHex, 1, 'buy recipient');
  assert(buySpend.outputs[3].binding === undefined && buySpend.outputs[4].binding === undefined, 'buy fee outputs must NOT carry bindings');
  console.log('   OK — curve/inventory/recipient bound, fee outputs unbound');

  console.log('3c. Curve sell (buildCpSell) output bindings: curve continuation (C) + inventory/change (A)...');
  const sellerKey = new k.PrivateKey(randomBytes(32).toString('hex'));
  const sellerXOnly = sellerKey.toPublicKey().toString().replace(/^0x/, '').slice(-64);
  const sellerPubBytes = Uint8Array.from(Buffer.from(sellerXOnly, 'hex'));
  const sellUtxo = { transactionId: 'dd'.repeat(32), index: 0, realKas: 50_000_000n, state: { graduated: false, tokenCovid, tokenReserve: 1000n } };
  const sellInventory = { transactionId: 'dd'.repeat(32), index: 1, value: 1000n, amount: 1000n };
  const sellerToken = { transactionId: 'ee'.repeat(32), index: 0, value: 1000n, state: kron.kcc20.addressPresenceOwned(sellerPubBytes, 100n) };
  const sellSpend = kron.curveCp.buildCpSell(k, cpTpl, tokenTpl, sellUtxo, [sellerToken], sellInventory, curveCovid, sellerPubBytes, 60n, 1_000_000n, 1);
  assert(sellSpend.outputs.length === 5, 'a fractional sell (change > 0) must produce 5 outputs');
  assertBinding(sellSpend.outputs[0], curveCovidHex, 0, 'sell curve continuation');
  assertBinding(sellSpend.outputs[1], tokenCovidHex, 1, 'sell inventory');
  assert(sellSpend.outputs[2].binding === undefined && sellSpend.outputs[3].binding === undefined, 'sell fee outputs must NOT carry bindings');
  assertBinding(sellSpend.outputs[4], tokenCovidHex, 1, 'sell seller change');
  console.log('   OK — curve/inventory/change bound, fee outputs unbound');

  console.log('3d. Curve graduate (buildCpGraduate) output bindings: locked curve (C) + pool genesis (P) + pool token (A)...');
  const gradCurveCovid = randomBytes(32);
  const gradTokenCovid = randomBytes(32);
  const gradCpTplRaw = syntheticTemplate(44, [[0, 0x01], [2, 0x20], [35, 0x08]]);
  const gradCpTpl = {
    ...gradCpTplRaw,
    params: { creatorFeeOwner: randomBytes(32), platformFeeOwner: randomBytes(32), vKas: 1000n, graduationKas: 5_000_000n, creatorFeeBps: 25n, platformFeeBps: 100n, graduationFeeBps: 500n },
  };
  const poolTplRaw = syntheticTemplate(93, [[0, 0x08], [9, 0x08], [18, 0x20], [51, 0x08], [60, 0x20]]);
  const poolTpl = { ...poolTplRaw };
  const gradUtxo = { transactionId: 'ff'.repeat(32), index: 0, realKas: 5_000_000n, state: { graduated: false, tokenCovid: gradTokenCovid, tokenReserve: 2500n } };
  const gradInventory = { transactionId: 'ff'.repeat(32), index: 1, value: 1000n, amount: 2500n };
  const gradSpend = kron.curveCp.buildCpGraduate(k, gradCpTpl, tokenTpl, poolTpl, gradUtxo, gradInventory, gradCurveCovid, 1000n);
  const gradPoolCovidHex = gradSpend.covids.poolCovid;
  assertBinding(gradSpend.outputs[0], hexOf(gradCurveCovid), 0, 'graduate locked curve');
  assertBinding(gradSpend.outputs[1], gradPoolCovidHex, 0, 'graduate pool genesis');
  assertBinding(gradSpend.outputs[2], hexOf(gradTokenCovid), 1, 'graduate pool token');
  assert(gradSpend.outputs[3].binding === undefined, 'graduate fee output must NOT carry a binding');
  console.log('   OK — locked curve/pool genesis/pool token bound, fee output unbound');

  console.log('3e. Pool v3 swap (buildPoolV3SwapKasForToken / buildPoolV3SwapTokenForKas) output bindings...');
  const swapPoolCovid = randomBytes(32);
  const swapTokenCovid = randomBytes(32);
  const swapPoolCovidHex = hexOf(swapPoolCovid);
  const swapTokenCovidHex = hexOf(swapTokenCovid);
  const swapPoolParams = { creatorFeeOwner: randomBytes(32), platformFeeOwner: randomBytes(32) };
  const swapPoolState = { kasReserve: 1000n, tokenReserve: 100_000n, tokenCovid: swapTokenCovid, totalShares: 1000n, lpCovid: new Uint8Array(32) };
  const swapPoolUtxo = { transactionId: '11'.repeat(32), index: 0, state: swapPoolState, tokenUtxo: { transactionId: '11'.repeat(32), index: 1, value: 1000n } };
  const buyQ = { kasInUnits: 10n, kasIn: 10n * kron.curve.SCALE, tokenOut: 500n, creatorOut: 20_000_000n, platformOut: 20_000_000n, newKas: 1010n, newToken: 99_500n };
  const swapBuySpend = kron.poolCpV3.buildPoolV3SwapKasForToken(k, poolTpl, tokenTpl, swapPoolParams, swapPoolUtxo, swapPoolCovid, sellerPubBytes, buyQ);
  assertBinding(swapBuySpend.outputs[0], swapPoolCovidHex, 0, 'pool swap-buy pool continuation');
  assertBinding(swapBuySpend.outputs[1], swapTokenCovidHex, 1, 'pool swap-buy pool token');
  assertBinding(swapBuySpend.outputs[2], swapTokenCovidHex, 1, 'pool swap-buy trader token');
  assert(swapBuySpend.outputs[3].binding === undefined && swapBuySpend.outputs[4].binding === undefined, 'pool swap-buy fee outputs must NOT carry bindings');
  const traderTokens = [{ transactionId: '22'.repeat(32), index: 0, value: 1000n, state: kron.kcc20.addressPresenceOwned(sellerPubBytes, 300n) }];
  const sellQ = { tokenIn: 200n, kasOutUnits: 5n, kasOut: 5n * kron.curve.SCALE, creatorOut: 20_000_000n, platformOut: 20_000_000n, newKas: 995n, newToken: 100_200n };
  const swapSellSpend = kron.poolCpV3.buildPoolV3SwapTokenForKas(k, poolTpl, tokenTpl, swapPoolParams, swapPoolUtxo, swapPoolCovid, sellerPubBytes, traderTokens, sellQ, 2);
  assert(swapSellSpend.outputs.length === 5, 'a fractional pool sell (change > 0) must produce 5 outputs');
  assertBinding(swapSellSpend.outputs[0], swapPoolCovidHex, 0, 'pool swap-sell pool continuation');
  assertBinding(swapSellSpend.outputs[1], swapTokenCovidHex, 1, 'pool swap-sell pool token');
  assert(swapSellSpend.outputs[2].binding === undefined && swapSellSpend.outputs[3].binding === undefined, 'pool swap-sell fee outputs must NOT carry bindings');
  assertBinding(swapSellSpend.outputs[4], swapTokenCovidHex, 1, 'pool swap-sell trader change');
  console.log('   OK — pool/poolToken/trader bound on both swap directions, fee outputs unbound');

  console.log('3f. Pool LP (buildBindLp / buildAddLiquidity / buildRemoveLiquidity) output bindings...');
  const bindPoolCovid = randomBytes(32);
  const bindState = { kasReserve: 2000n, tokenReserve: 50_000n, tokenCovid: swapTokenCovid, totalShares: 1000n, lpCovid: new Uint8Array(32) };
  const bindUtxo = { transactionId: '33'.repeat(32), index: 0, state: bindState, tokenUtxo: { transactionId: '33'.repeat(32), index: 1, value: 1000n } };
  const bindSpend = kron.poolCp.buildBindLp(k, poolTpl, tokenTpl, bindUtxo, bindPoolCovid, 1000n);
  assertBinding(bindSpend.outputs[0], hexOf(bindPoolCovid), 0, 'bindLp pool continuation');
  assertBinding(bindSpend.outputs[1], bindSpend.lpCovidHex, 0, 'bindLp locked floor');
  assertBinding(bindSpend.outputs[2], bindSpend.lpCovidHex, 0, 'bindLp pool inventory');

  const addPoolCovid = randomBytes(32);
  const addTokenCovid = randomBytes(32);
  const addLpCovid = randomBytes(32); // stands in for an already-bound L covid
  const addState = { kasReserve: 1000n, tokenReserve: 100_000n, tokenCovid: addTokenCovid, totalShares: 1000n, lpCovid: addLpCovid };
  const addUtxo = { transactionId: '44'.repeat(32), index: 0, state: addState, tokenUtxo: { transactionId: '44'.repeat(32), index: 1, value: 1000n } };
  const addLpInventory = { transactionId: '44'.repeat(32), index: 2, value: 1000n, amount: 5000n };
  const lpDepositPub = randomBytes(32);
  const addQ = kron.poolCp.quoteAddLiquidity(addState, 10n);
  const lpDepositToken = { transactionId: '55'.repeat(32), index: 0, value: 1000n, state: kron.kcc20.addressPresenceOwned(lpDepositPub, addQ.dToken) };
  const addSpend = kron.poolCp.buildAddLiquidity(k, poolTpl, tokenTpl, addUtxo, addLpInventory, addPoolCovid, lpDepositToken, lpDepositPub, addQ, 4);
  const addTokenCovidHex = hexOf(addTokenCovid);
  const addLpCovidHex = hexOf(addLpCovid);
  assertBinding(addSpend.outputs[0], hexOf(addPoolCovid), 0, 'addLiquidity pool continuation');
  assertBinding(addSpend.outputs[1], addTokenCovidHex, 2, 'addLiquidity grown reserve');
  assertBinding(addSpend.outputs[2], addLpCovidHex, 3, 'addLiquidity reduced L inventory');
  assertBinding(addSpend.outputs[3], addLpCovidHex, 3, "addLiquidity LP's new shares");

  const remState = { kasReserve: 1000n, tokenReserve: 100_000n, tokenCovid: addTokenCovid, totalShares: 1000n, lpCovid: addLpCovid };
  const remUtxo = { transactionId: '66'.repeat(32), index: 0, state: remState, tokenUtxo: { transactionId: '66'.repeat(32), index: 1, value: 1000n } };
  const remQ = kron.poolCp.quoteRemoveLiquidity(remState, { lockedShares: 100n }, 10n);
  const lpSharesPub = randomBytes(32);
  const lpSharesUtxo = { transactionId: '77'.repeat(32), index: 0, value: 1000n, state: kron.kcc20.addressPresenceOwned(lpSharesPub, remQ.dShares) };
  const remSpend = kron.poolCp.buildRemoveLiquidity(k, poolTpl, tokenTpl, remUtxo, lpSharesUtxo, addPoolCovid, lpSharesPub, remQ, 3);
  assertBinding(remSpend.outputs[0], hexOf(addPoolCovid), 0, 'removeLiquidity pool continuation');
  assertBinding(remSpend.outputs[1], addTokenCovidHex, 1, 'removeLiquidity shrunk reserve');
  assertBinding(remSpend.outputs[2], addTokenCovidHex, 1, "removeLiquidity LP's withdrawn token");
  assertBinding(remSpend.outputs[3], addLpCovidHex, 2, 'removeLiquidity shares returned to inventory');
  console.log('   OK — bindLp/addLiquidity/removeLiquidity outputs all correctly bound');

  console.log('3g. Vesting claim (buildVestingClaim / buildVestingClaimFinal) output bindings...');
  const vestTplRaw = syntheticTemplate(9, [[0, 0x08]]);
  const vestTpl = { ...vestTplRaw, stateLen: 9, params: { creatorIdentifier: buyerXOnly, total: 1000, startScore: 0, durationScore: 100 } };
  const vestingCovid = randomBytes(32);
  const vestingCovidHex = hexOf(vestingCovid);
  const vestTokenCovidHex = hexOf(randomBytes(32));
  const creatorPub = randomBytes(32);
  const claimVestingUtxo = { transactionId: '88'.repeat(32), index: 0, value: 1000n };
  const claimLockedToken = { transactionId: '88'.repeat(32), index: 1, value: 1000n };
  const claimSpend = kron.vesting.buildVestingClaim(k, vestTpl, tokenTpl, claimVestingUtxo, claimLockedToken, vestingCovid, creatorPub, 200n, 300n, { tokenCovid: vestTokenCovidHex });
  assertBinding(claimSpend.outputs[0], vestingCovidHex, 0, 'vesting claim continuation');
  assertBinding(claimSpend.outputs[1], vestTokenCovidHex, 1, 'vesting claim relock');
  assertBinding(claimSpend.outputs[2], vestTokenCovidHex, 1, 'vesting claim recipient');
  const claimFinalSpend = kron.vesting.buildVestingClaimFinal(k, vestTpl, tokenTpl, claimVestingUtxo, claimLockedToken, vestingCovid, creatorPub, 900n, { tokenCovid: vestTokenCovidHex });
  assertBinding(claimFinalSpend.outputs[0], vestingCovidHex, 0, 'vesting claimFinal continuation');
  assertBinding(claimFinalSpend.outputs[1], vestTokenCovidHex, 1, 'vesting claimFinal recipient');
  const claimFinalNoBind = kron.vesting.buildVestingClaimFinal(k, vestTpl, tokenTpl, claimVestingUtxo, claimLockedToken, vestingCovid, creatorPub, 900n);
  assert(claimFinalNoBind.outputs[0].binding, 'vesting continuation must always be bound (vestingCovid is a required param)');
  assert(claimFinalNoBind.outputs[1].binding === undefined, 'recipient output must be unbound when opts.tokenCovid is omitted');
  console.log('   OK — vesting continuation always bound; token outputs bound when opts.tokenCovid is passed, unbound otherwise');

  console.log('4. Full-tx assembly (spend.assembleNativeTx) + signPskt-style local signing...');
  const fundingEntry = {
    amount: 20_000_000_000n, // covers kasIn (~100 KAS) + fees + network fee
    outpoint: { transactionId: 'bb'.repeat(32), index: 0 },
    scriptPublicKey: k.payToAddressScript(buyerPub.toAddress(k.NetworkType.Testnet)),
    blockDaaScore: 0n, isCoinbase: false,
  };
  const asm = kron.spend.assembleNativeTx(k, { spend: buySpend, fundingEntries: [fundingEntry], changeAddress: buyerPub.toAddress(k.NetworkType.Testnet).toString(), networkFee: 5000n });
  assert(asm.fundingInputIndexes.length === 1, 'exactly one funding input expected');
  assert(Number(asm.transaction.version) === kron.spend.TX_VERSION, `assembled tx must be v${kron.spend.TX_VERSION} (KIP-20 covenant tx), got v${asm.transaction.version}`);
  const pskt = kron.spend.toPsktJson(asm);
  const signed = kron.spend.signPsktWithKey(k, pskt.txJsonString, pskt.signInputs, buyerKey);
  const reparsed = k.Transaction.deserializeFromSafeJSON(signed);
  assert(reparsed.inputs[asm.fundingInputIndexes[0]].signatureScript.length > 0, 'the funding input must now carry a signature script');
  assert(reparsed.inputs[0].signatureScript === buySpend.inputs[0].signatureScript, 'covenant input 0 signature script must be UNTOUCHED by wallet signing — this is the core fund-safety property');
  console.log('   OK — v1 tx; signing touched ONLY the funding input, covenant inputs untouched');

  console.log('4b. KCC-20 send (decodeKcc20Redeem + buildKcc20Send): outputs must carry covenant bindings...');
  const senderPub32 = randomBytes(32);
  const recipientPub32 = randomBytes(32);
  const liveRedeem = kron.kcc20.materializeKcc20Script(tokenTpl, kron.kcc20.addressPresenceOwned(senderPub32, 7753n));
  const dec = kron.kcc20.decodeKcc20Redeem(liveRedeem);
  assert(dec.template.stateStart === tokenTpl.stateStart, 'decode must find the state region where materialize spliced it');
  assert(dec.state.amount === 7753n && dec.state.identifierType === kron.kcc20.IDENTIFIER.ADDRESS, 'decode must recover amount + ownership mode');
  assert(Buffer.from(dec.state.ownerIdentifier).equals(senderPub32), 'decode must recover the owner pubkey');
  const sendSpend = kron.kcc20.buildKcc20Send(
    k, dec.template,
    [{ transactionId: 'cc'.repeat(32), index: 0, value: kron.spend.COVENANT_DUST, state: dec.state }],
    recipientPub32, 3n, 1, tokenCovidHex,
  );
  assert(sendSpend.economics.change === 7750n, 'send must conserve: 7753 -> 3 + 7750');
  const sendAsm = kron.spend.assembleNativeTx(k, { spend: sendSpend, fundingEntries: [fundingEntry], changeAddress: buyerPub.toAddress(k.NetworkType.Testnet).toString(), networkFee: 10_000n });
  for (const [i, out] of [...sendAsm.transaction.outputs.slice(0, 2)].entries()) {
    const b = out.covenant;
    assert(b, `token output ${i} must carry a CovenantBinding`);
    assert(String(b.covenantId ?? b.covenant_id ?? '').replace(/^0x/, '') === tokenCovidHex, `token output ${i} binding must target the token covid`);
  }
  assert(sendAsm.transaction.outputs[2].covenant === undefined, 'the KAS change output must NOT carry a binding');
  console.log('   OK — send outputs bound to the token covenant id, change unbound');

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
