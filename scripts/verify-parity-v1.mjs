// Family parity guard (0.20) — proves this SDK's KCC-20 STANDARD-family builders (`curveKcc20`, `poolKcc20`, `orderKcc20`,
// `transferKcc20`, `kcc20V1`, `covenantV1`, `spendV1`, `dispatchTag`, `templatesV1`, `l1Fee`) produce BYTE-IDENTICAL
// transactions to the reference builders in the private kron monorepo (web/src/native/*Kcc20*.ts, covenantTxKcc20V1.ts,
// spendV1.ts — the ones kron's VM gates verify:mass-v1 / verify:kcc20v1-sighash run against the v1.0.0 toolchain).
//
// Same posture as verify-parity.mjs: it needs the kron repo (default ../kron, or $KRON_REPO) with its vendored kaspa WASM,
// its vendored silverc v1.0.0 WASM compiler (web/src/vendor/silverc-v1) and its node_modules; when they are missing it
// FAILS CLOSED unless KRON_PARITY_OPTIONAL=1 (skip with a notice). A missing dist/ is never excused. Both sides share ONE
// kaspa WASM instance (kron's) because every builder takes `k` as an argument — WASM objects cannot cross instances.
//
// What is compared, per production shape (kron covenants/kcc20v1/tests/_shapes.mjs list + transfers):
//   • the CovenantSpendV1 (inputs: outpoint, value, spk, pre-scripted signature script, redeem, role, covid, invocation;
//     outputs: value, spk, role, covenant binding; covids; economics / quotes; fixedOutputs) — byte-identical JSON;
//   • the assembled UNSIGNED transaction (Safe JSON) and the index lists / totals assembleFamilyTx returns;
//   • the dev-key-signed transaction with the 64 signature bytes masked (Schnorr signing is randomized), so witness
//     placement, lengths and the SIGHASH byte are compared; the SDK's signed tx also passes assertInvocationsV1,
//     withinCapsV1 and assertSighashAllV1;
//   • describeSpendV1, walletRequestV1 (the KCC-12 §6.7 request), massDimsV1 and feeForTxV1.
// Plus the pure surface: dispatch tags, KCC-1 template hashes, state encoders / decoders, int8 / pushes, quotes, order
// escrow, L1 fee helpers, every bound and compute-budget constant.
//
// `--write-fixture` additionally writes src/native/__fixtures__/kcc20v1-templates.json — the four programs compiled for
// the test params (what the vitest suite builds against offline). Run:  npm run verify:parity:v1
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SDK = resolve(here, '..');
const KRON = process.env.KRON_REPO ? resolve(process.env.KRON_REPO) : resolve(SDK, '../kron');
const SDK_DIST = `${SDK}/dist/index.js`;
const WRITE_FIXTURE = process.argv.includes('--write-fixture');
const FIXTURE = `${SDK}/src/native/__fixtures__/kcc20v1-templates.json`;
const N = `${KRON}/web/src/native`;
const REF = {
  shapes: `${KRON}/covenants/kcc20v1/tests/_shapes.mjs`,
  kcc20V1: `${N}/kcc20V1Tx.ts`, curve: `${N}/curveKcc20Tx.ts`, pool: `${N}/poolKcc20Tx.ts`, order: `${N}/orderKcc20Tx.ts`, transfer: `${N}/transferKcc20Tx.ts`,
  covenant: `${N}/covenantTxKcc20V1.ts`, spendV1: `${N}/spendV1.ts`, dispatchTag: `${N}/dispatchTag.ts`, l1Fee: `${N}/l1Fee.ts`, compile: `${N}/compileTemplatesV1.ts`,
  silvercWasm: `${KRON}/web/src/vendor/silverc-v1/silverc_v1_wasm_bg.wasm`, kaspa: `${KRON}/web/src/vendor/kaspa/kaspa.js`, noble: `${KRON}/node_modules/@noble/hashes/package.json`,
};

if (!existsSync(SDK_DIST)) {
  console.error(`✗ FAMILY PARITY CHECK FAILED — ${SDK_DIST.replace(SDK, '.')} not found. Run \`npm run build\` first.`);
  console.error(`  (Parity compares BUILT output; a missing build is not a missing toolchain, so KRON_PARITY_OPTIONAL does not skip this.)`);
  process.exit(1);
}
const missing = Object.values(REF).filter((p) => !existsSync(p));
if (missing.length) {
  const detail = `missing: ${missing.map((p) => p.replace(KRON, '<kron>')).join(', ')}`;
  if (process.env.KRON_PARITY_OPTIONAL === '1') {
    console.log(`⚠  FAMILY PARITY CHECK SKIPPED (KRON_PARITY_OPTIONAL=1) — reference toolchain not found.`);
    console.log(`   ${detail}`);
    console.log(`   Parity was NOT verified. It is enforced at publish time (prepublishOnly runs without this flag).`);
    process.exit(0);
  }
  console.error(`✗ FAMILY PARITY CHECK FAILED — reference toolchain not found and KRON_PARITY_OPTIONAL is not set.`);
  console.error(`   ${detail}`);
  console.error(`   Fix: set KRON_REPO=<path to the kron monorepo> (default: ../kron sibling) with its node_modules installed`);
  console.error(`   and web/src/vendor/{kaspa,silverc-v1} present — or set KRON_PARITY_OPTIONAL=1 where the private toolchain is absent.`);
  process.exit(1);
}

// --- load the reference side (kron) and this SDK's built output -------------------------------------------------
const imp = (p) => import(pathToFileURL(p).href);
const S = await imp(REF.shapes);                                   // compileBuild / KEYS / PARAMS / fundingEntry / k
const k = S.k, NET = S.NETWORK_ID;
const R = {
  kcc20V1: await imp(REF.kcc20V1), curve: await imp(REF.curve), pool: await imp(REF.pool), order: await imp(REF.order), transfer: await imp(REF.transfer),
  covenant: await imp(REF.covenant), spendV1: await imp(REF.spendV1), dispatchTag: await imp(REF.dispatchTag), l1Fee: await imp(REF.l1Fee), compile: await imp(REF.compile),
};
const SDK_MOD = await imp(SDK_DIST);
const D = {
  kcc20V1: SDK_MOD.kcc20V1, curve: SDK_MOD.curveKcc20, pool: SDK_MOD.poolKcc20, order: SDK_MOD.orderKcc20, transfer: SDK_MOD.transferKcc20,
  covenant: SDK_MOD.covenantV1, spendV1: SDK_MOD.spendV1, dispatchTag: SDK_MOD.dispatchTag, l1Fee: SDK_MOD.l1Fee, compile: SDK_MOD.templatesV1,
};
for (const [name, ns] of Object.entries(D)) if (!ns) { console.error(`✗ dist/index.js lacks the ${name} family namespace — rebuild`); process.exit(1); }
const { blake3 } = await imp(`${KRON}/node_modules/@noble/hashes/blake3.js`);

let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fails++; console.log(`  ✗ ${m}`); } };
const hex = (u8) => Buffer.from(u8).toString('hex');
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const safe = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? `0x${hex(x)}` : x && typeof x === 'object' && !Array.isArray(x) && typeof x.toString === 'function' && x.constructor && !['Object'].includes(x.constructor.name) ? String(x.toString()) : x));
const same = (a, b, m) => { const sa = safe(a), sb = safe(b); ok(sa === sb, m + (sa === sb ? '' : `\n      ref ${sa.slice(0, 160)}\n      sdk ${sb.slice(0, 160)}`)); };

// --- templates: ONE compile (reference sources, silverc v1.0.0 WASM, the test params), shaped by BOTH sides -------------
const B = S.compileBuild('reference');
const KEYS = S.KEYS, PARAMS = S.PARAMS;
const curveParams = { creatorFeeOwner: KEYS.creator.pub, platformFeeOwner: KEYS.platform.pub, devFundOwner: KEYS.dev.pub, creatorIdentifier: KEYS.creator.pub, vKas: 1000n, graduationKas: 50_000_000n, creatorFeeBps: 25n, platformFeeBps: 90n, graduationFeeBps: 500n, devFundBps: 10n, poolLockedShares: 1000n };
const poolParams = { creatorFeeOwner: KEYS.creator.pub, platformFeeOwner: KEYS.platform.pub, creatorFeeBps: 10n, platformFeeBps: 70n, lpFeeBps: 20n, lockedShares: 1000n };
const T = {
  ref: { token: B.token, curve: B.curve, pool: B.pool, order: B.order },
  sdk: (() => { const token = D.kcc20V1.tokenTemplateFromCompiledV1(B.compiled.token); return { token, curve: D.curve.curveTemplateFromCompiledV1(B.compiled.curve, curveParams, token), pool: D.pool.poolTemplateFromCompiledV1(B.compiled.pool, poolParams, token), order: D.order.orderTemplateFromCompiledV1(B.compiled.order, token) }; })(),
};
console.log('\n[1] templates shaped from the same compiled programs');
for (const p of ['token', 'curve', 'pool', 'order']) same(T.ref[p], T.sdk[p], `${p} template (prefix, suffix, template hash, tags, params)`);
{ // the server-answer adapter: the compile output re-read through compiledFromServerV1 equals the compiled program
  const asServer = (c) => ({ name: c.name, bytecodeHex: c.bytecodeHex, stateSpan: c.stateSpan, prefixLen: c.prefix.length, suffixLen: c.suffix.length, templateHash: c.templateHash, dispatchTags: c.dispatchTags });
  const re = D.compile.familyFromServerV1({ token: asServer(B.compiled.token), curve: asServer(B.compiled.curve), pool: asServer(B.compiled.pool), order: asServer(B.compiled.order) });
  ok(['token', 'curve', 'pool', 'order'].every((p) => hex(re[p].prefix) === hex(B.compiled[p].prefix) && hex(re[p].suffix) === hex(B.compiled[p].suffix) && re[p].templateHash === B.compiled[p].templateHash), 'templatesV1.familyFromServerV1 re-derives prefix / suffix / template hash from the server shape');
  same(hex(R.compile.templateHashV1(B.compiled.curve.prefix, B.compiled.curve.suffix)), hex(D.compile.templateHashV1(B.compiled.curve.prefix, B.compiled.curve.suffix)), 'templateHashV1 (KCC-1 §3.7.3) agrees on the compiled curve');
  ok(hex(D.compile.templateHashV1(B.compiled.curve.prefix, B.compiled.curve.suffix)) === B.compiled.curve.templateHash, 'templateHashV1 equals the compiler-reported template hash');
}

console.log('\n[2] pure surface');
for (const p of ['token', 'curve', 'pool', 'order']) same(R.dispatchTag.familyTagsV1(p), D.dispatchTag.familyTagsV1(p), `dispatch tags: ${p}`);
same(R.dispatchTag.TOKEN_DISPATCH_TAGS, D.dispatchTag.TOKEN_DISPATCH_TAGS, 'TOKEN_DISPATCH_TAGS');
same(R.dispatchTag.FAMILY_SIGNATURES, D.dispatchTag.FAMILY_SIGNATURES, 'FAMILY_SIGNATURES');
for (const [pre, suf] of [['', ''], ['61', '6263'], ['6162', '63'], ['00ff', '100080']]) same(hex(R.compile.templateHashV1(fromHex(pre), fromHex(suf))), hex(D.compile.templateHashV1(fromHex(pre), fromHex(suf))), `templateHashV1(${pre || '∅'}, ${suf || '∅'})`);
const A = fromHex('11'.repeat(32)), C = fromHex('cc'.repeat(32)), P = fromHex('ee'.repeat(32)), LP = fromHex('dd'.repeat(32));
const states = [R.kcc20V1.p2pkOwnedV1(KEYS.trader.pub, 1n), R.kcc20V1.p2pkOwnedV1(KEYS.trader.pub, 2n ** 53n + 7n), R.kcc20V1.covenantOwnedV1(C, 900_000_000n), { ...R.kcc20V1.p2pkOwnedV1(KEYS.lp.pub, 5n), ownerScheme: 1, borrowScheme: 1, borrowGuard: fromHex('f4' + '00'.repeat(31)) }];
for (const [i, s] of states.entries()) {
  same(R.kcc20V1.encodeKcc20V1State(T.ref.token.templateHash, s), D.kcc20V1.encodeKcc20V1State(T.sdk.token.templateHash, s), `encodeKcc20V1State #${i}`);
  const redeem = D.kcc20V1.materializeKcc20V1Script(T.sdk.token, s);
  same(R.kcc20V1.decodeKcc20V1State(redeem), D.kcc20V1.decodeKcc20V1State(redeem), `decodeKcc20V1State #${i}`);
  same(R.kcc20V1.kcc20V1Address(k, T.ref.token, s, NET), D.kcc20V1.kcc20V1Address(k, T.sdk.token, s, NET), `kcc20V1Address #${i}`);
}
for (const v of [0n, 1n, -1n, 127n, 128n, 255n, 256n, 2n ** 32n, 2n ** 63n - 1n, -(2n ** 63n - 1n)]) same(R.kcc20V1.int8SM(v), D.kcc20V1.int8SM(v), `int8SM(${v})`);
for (const n of [0, 1, 75, 76, 255, 256, 600]) same(R.kcc20V1.pushExplicit(new Uint8Array(n).fill(0xab)), D.kcc20V1.pushExplicit(new Uint8Array(n).fill(0xab)), `pushExplicit(${n} bytes)`);
for (const n of [0, 1, 16, 75, 76, 255, 256, 70000]) same(R.covenant.pushMinimalV1(new Uint8Array(n).fill(0x11)), D.covenant.pushMinimalV1(new Uint8Array(n).fill(0x11)), `pushMinimalV1(${n} bytes)`);
same(R.curve.encodeCurveV1State({ graduated: true, tokenCovid: A, tokenReserve: 123_456_789n }), D.curve.encodeCurveV1State({ graduated: true, tokenCovid: A, tokenReserve: 123_456_789n }), 'encodeCurveV1State');
same(R.pool.encodePoolV1State({ kasReserve: 1n, tokenReserve: 2n, tokenCovid: A, totalShares: 3n, lpCovid: LP }), D.pool.encodePoolV1State({ kasReserve: 1n, tokenReserve: 2n, tokenCovid: A, totalShares: 3n, lpCovid: LP }), 'encodePoolV1State');
same(R.order.encodeOrderV1State({ curveCovid: C, buyerIdentifier: KEYS.trader.pub, tokenCovid: A, kasIn: 5n * 10n ** 9n, minTokenOut: 7n }), D.order.encodeOrderV1State({ curveCovid: C, buyerIdentifier: KEYS.trader.pub, tokenCovid: A, kasIn: 5n * 10n ** 9n, minTokenOut: 7n }), 'encodeOrderV1State');
const fee = { creatorFeeBps: 25n, platformFeeBps: 90n, devFundBps: 10n };
for (const kasIn of [50_000_000n, 1_000_000_000n, 123_456_789_012n]) { same(R.order.orderEscrowV1(kasIn, fee), D.order.orderEscrowV1(kasIn, fee), `orderEscrowV1(${kasIn})`); same(R.order.orderFeesV1(kasIn, fee), D.order.orderFeesV1(kasIn, fee), `orderFeesV1(${kasIn})`); }
for (const [kas, tok, x] of [[100_000n, 1_000_000n, 10n * 10n ** 8n], [5_000_000n, 300_000n, 25n * 10n ** 8n]]) {
  const st = { kasReserve: kas, tokenReserve: tok, tokenCovid: A, totalShares: 1000n, lpCovid: LP };
  same(R.pool.quotePoolV1Buy(st, poolParams, x), D.pool.quotePoolV1Buy(st, poolParams, x), `quotePoolV1Buy(${kas},${tok},${x})`);
  same(R.pool.quotePoolV1Sell(st, poolParams, 50_000n), D.pool.quotePoolV1Sell(st, poolParams, 50_000n), `quotePoolV1Sell(${kas},${tok})`);
  same(R.pool.quoteAddLiquidityV1(st, 10_000n), D.pool.quoteAddLiquidityV1(st, 10_000n), `quoteAddLiquidityV1(${kas},${tok})`);
  const st2 = { ...st, totalShares: 1100n };
  same(R.pool.quoteRemoveLiquidityV1(st2, poolParams, 100n), D.pool.quoteRemoveLiquidityV1(st2, poolParams, 100n), `quoteRemoveLiquidityV1(${kas},${tok})`);
}
for (const [mass, rate] of [[1n, 100], [10_000n, 100], [123_456n, 250], [500_000n, 1]]) same(R.l1Fee.feeForMass(mass, rate), D.l1Fee.feeForMass(mass, rate), `feeForMass(${mass}, ${rate})`);
for (const b of [0n, 100n, 4_000n, 65_535n]) same(R.l1Fee.normalizedTransientMass(b), D.l1Fee.normalizedTransientMass(b), `normalizedTransientMass(${b})`);
for (const [b, r] of [[647, 100], [4031, 100], [14651, 250]]) same(R.l1Fee.estimateCovenantL1Fee(b, r), D.l1Fee.estimateCovenantL1Fee(b, r), `estimateCovenantL1Fee(${b}, ${r})`);
const consts = { curve: ['MAX_TOKEN', 'MAX_MERGE_PIECES', 'MAX_SELL_PIECES', 'MAX_BATCH', 'CURVE_V1_STATE_LEN', 'SCALE'], pool: ['POOL_V1_STATE_LEN', 'MAX_TRADER_PIECES', 'MAX_SHARES'], order: ['ORDER_V1_STATE_LEN', 'MIN_ORDER_KAS', 'ORDER_TOKEN_DUST', 'ORDER_TX_FEE'], transfer: ['COVENANT_DUST_V1', 'MAX_TRANSFER_PIECES'], kcc20V1: ['KCC20V1_STATE_LEN', 'KCC20V1_STATE_OFFSET', 'OWNER_SCHEME', 'BORROW_SCHEME', 'SIG65_LEN', 'KCC20V1_FRAMING'], covenant: ['TX_VERSION', 'SUBNET_ZERO', 'MASS_CAP', 'FUNDING_COMPUTE_V1', 'CURVE_V1_COMPUTE', 'POOL_V1_COMPUTE', 'ORDER_V1_COMPUTE', 'TOKEN_V1_COMPUTE'], l1Fee: ['TRANSIENT_BYTE_TO_MASS_FACTOR', 'COMPUTE_MASS_LIMIT', 'TRANSIENT_MASS_LIMIT', 'FEE_BUFFER_NUM', 'FEE_BUFFER_DEN', 'MIN_FEE_SOMPI', 'MIN_FEE_RATE'] };
for (const [ns, names] of Object.entries(consts)) for (const n of names) same(R[ns][n], D[ns][n], `${ns}.${n}`);

// --- the shapes: both sides build, assemble and sign the same list from the same inputs ----------------------------------
const op = (i) => ({ transactionId: i.toString(16).padStart(2, '0').repeat(32), index: 0 });
const DUST = 50_000_000n, KAS = 100_000_000n;
const keyByPub = new Map(Object.values(KEYS).map((x) => [x.hex, x]));
const p2pkAddress = (who) => k.addressFromScriptPublicKey(new k.ScriptPublicKey(0, `20${who.hex}ac`), NET).toString();
function shapesWith(M, tpl) {
  const { token, curve, pool, order } = tpl;
  const cs = (graduated, tokenCovid, tokenReserve) => ({ graduated, tokenCovid, tokenReserve });
  const curveUtxo = (realKas, state) => ({ ...op(0), realKas, state });
  const inventory = (i, amount) => ({ ...op(i), value: DUST, amount });
  const piece = (i, who, amount) => ({ ...op(i), value: DUST, state: M.kcc20V1.p2pkOwnedV1(who.pub, amount) });
  const poolState = (kas, tok, shares, lp) => ({ kasReserve: kas, tokenReserve: tok, tokenCovid: A, totalShares: shares, lpCovid: lp });
  const poolUtxo = (state) => ({ ...op(0), state, tokenUtxo: { ...op(1), value: DUST } });
  const lpInv = (i, shares) => ({ ...op(i), value: DUST, amount: M.pool.MAX_SHARES - shares });
  const orderUtxo = (i, covidHex, buyer, kasIn, minOut) => ({ ...op(i), value: M.order.orderEscrowV1(kasIn, fee), covid: covidHex, state: { curveCovid: C, buyerIdentifier: buyer.pub, tokenCovid: A, kasIn, minTokenOut: minOut } });
  const live = cs(false, A, 1_000_000n), ps = poolState(100_000n, 1_000_000n, 1000n, LP), ps2 = poolState(110_000n, 1_100_000n, 1100n, LP), ps0 = poolState(100_000n, 1_000_000n, 1000n, M.kcc20V1.ZERO32);
  const f = (i, who, amount) => S.fundingEntry(i, who, amount);
  const o1 = orderUtxo(2, '51'.repeat(32), KEYS.trader, 50n * KAS, 1n), o2 = orderUtxo(3, '52'.repeat(32), KEYS.buyer2, 50n * KAS, 1n);
  return [
    ['init', () => M.curve.buildCurveV1Init(k, curve, curveUtxo(100n * KAS, cs(false, M.kcc20V1.ZERO32, 0n)), C, 900_000_000n, 100_000_000n, { tokenDust: DUST }), [f(1, KEYS.creator)]],
    ['buy (plain)', () => M.curve.buildCurveV1Buy(k, curve, curveUtxo(100n * KAS, live), inventory(1, 1_000_000n), C, KEYS.trader.pub, 10n * KAS, 9_009n, [], { tokenDust: DUST, blake3 }), [f(2, KEYS.trader)]],
    ['buy (1 merge)', () => M.curve.buildCurveV1Buy(k, curve, curveUtxo(100n * KAS, live), inventory(1, 1_000_000n), C, KEYS.trader.pub, 10n * KAS, 9_009n, [piece(2, KEYS.trader, 500n)], { tokenDust: DUST, blake3 }), [f(3, KEYS.trader)]],
    ['buy (2 merges)', () => M.curve.buildCurveV1Buy(k, curve, curveUtxo(100n * KAS, live), inventory(1, 1_000_000n), C, KEYS.trader.pub, 10n * KAS, 9_009n, [piece(2, KEYS.trader, 500n), piece(3, KEYS.trader, 300n)], { tokenDust: DUST, blake3 }), [f(4, KEYS.trader)]],
    ['sell (1 piece)', () => M.curve.buildCurveV1Sell(k, curve, curveUtxo(100n * KAS, live), [piece(2, KEYS.trader, 10_000n)], inventory(1, 1_000_000n), C, KEYS.trader.pub, 10_000n, 1n * KAS, { tokenDust: DUST, blake3 }), [f(3, KEYS.trader)]],
    ['sell (2 pieces + change)', () => M.curve.buildCurveV1Sell(k, curve, curveUtxo(100n * KAS, live), [piece(2, KEYS.trader, 6_000n), piece(3, KEYS.trader, 4_400n)], inventory(1, 1_000_000n), C, KEYS.trader.pub, 10_000n, 1n * KAS, { tokenDust: DUST, blake3 }), [f(4, KEYS.trader)]],
    ['graduate', () => M.curve.buildCurveV1Graduate(k, curve, curveUtxo(100n * KAS, live), inventory(1, 1_000_000n), C, pool, { tokenDust: DUST }), [f(2, KEYS.trader)]],
    ['batchBuy (2 orders)', () => M.curve.buildCurveV1BatchBuy(k, curve, order, curveUtxo(100n * KAS, live), inventory(1, 1_000_000n), C, [o1, o2]), []],
    ['order refund', () => M.order.buildOrderV1Refund(k, order, orderUtxo(0, '51'.repeat(32), KEYS.trader, 50n * KAS, 1n), 1), [f(1, KEYS.trader)]],
    ['pool swapKasForToken', () => M.pool.buildPoolV1SwapKasForToken(k, pool, poolUtxo(ps), P, KEYS.trader.pub, 10n * KAS, { tokenDust: DUST }), [f(2, KEYS.trader)]],
    ['pool swapTokenForKas (1 piece)', () => M.pool.buildPoolV1SwapTokenForKas(k, pool, poolUtxo(ps), P, KEYS.trader.pub, [piece(2, KEYS.trader, 52_632n)], 52_632n, { tokenDust: DUST, blake3 }), [f(3, KEYS.trader)]],
    ['pool swapTokenForKas (2 pieces + change)', () => M.pool.buildPoolV1SwapTokenForKas(k, pool, poolUtxo(ps), P, KEYS.trader.pub, [piece(2, KEYS.trader, 50_000n), piece(3, KEYS.trader, 3_032n)], 52_632n, { tokenDust: DUST, blake3 }), [f(4, KEYS.trader)]],
    ['pool addLiquidity', () => M.pool.buildPoolV1AddLiquidity(k, pool, poolUtxo(ps), lpInv(3, 1000n), P, LP, piece(2, KEYS.lp, 100_000n), KEYS.lp.pub, 10_000n, { tokenDust: DUST, blake3 }), [f(4, KEYS.lp, 200n * KAS)]],
    ['pool removeLiquidity', () => M.pool.buildPoolV1RemoveLiquidity(k, pool, poolUtxo(ps2), lpInv(2, 1100n), P, LP, { ...op(3), value: DUST, state: M.kcc20V1.p2pkOwnedV1(KEYS.lp.pub, 100n) }, KEYS.lp.pub, { tokenDust: DUST, blake3 }), [f(4, KEYS.lp)]],
    ['pool bindLp', () => M.pool.buildPoolV1BindLp(k, pool, poolUtxo(ps0), P), [f(1, KEYS.trader)]],
    ['transfer (1 piece)', () => M.transfer.buildTokenTransferV1(k, token, A, [piece(0, KEYS.trader, 1_000n)], KEYS.trader.pub, KEYS.buyer2.pub, 400n), [f(1, KEYS.trader)]],
    ['transfer (2 pieces)', () => M.transfer.buildTokenTransferV1(k, token, A, [piece(0, KEYS.trader, 600n), piece(1, KEYS.trader, 400n)], KEYS.trader.pub, KEYS.buyer2.pub, 1_000n), [f(2, KEYS.trader)]],
  ];
}
const spendJson = (s) => safe({
  kind: s.kind, fixedOutputs: s.fixedOutputs ?? null, covids: s.covids ?? null, economics: s.economics ?? null, quote: s.quote ?? null,
  inputs: s.inputs.map((i) => ({ tx: i.transactionId, idx: i.index, val: i.value, spk: String(i.scriptPublicKey?.script ?? i.scriptPublicKey), sig: i.signatureScript, redeem: i.redeem, role: i.role, covid: i.covid, sign: i.sign ?? null, invocation: i.invocation, compute: i.computeBudget ?? i.compute ?? null })),
  outputs: s.outputs.map((o) => ({ val: o.value, spk: String(o.scriptPublicKey?.script ?? o.scriptPublicKey), role: o.role, covenant: o.covenant ?? null })),
});
/** Zero the 64 signature bytes of every wallet-produced signature (funding P2PK scripts, token witnesses), keep everything else. */
function maskSigs(M, txJson, asm) {
  const j = JSON.parse(txJson);
  for (const i of asm.fundingInputIndexes) j.inputs[i].signatureScript = '41' + '00'.repeat(64) + '01';
  for (const i of asm.tokenSignInputIndexes) {
    const pushes = M.covenant.parsePushesV1(fromHex(j.inputs[i].signatureScript));
    const w = pushes[pushes.length - 3].payload; const off = w[0] === 0 && [66, 98, 99].includes(w.length) ? 1 : 0;
    w.fill(0, off, off + 64);
    j.inputs[i].signatureScript = hex(Buffer.concat(pushes.map((p) => Buffer.from(M.covenant.pushMinimalV1(p.payload)))));
  }
  return JSON.stringify(j);
}
async function runSide(M, tpl) {
  const out = [];
  for (const [name, build, funding] of shapesWith(M, tpl)) {
    const spend = build();
    const totalIn = spend.inputs.reduce((s, i) => s + i.value, 0n) + funding.reduce((s, e) => s + e.amount, 0n);
    const totalOut = spend.outputs.reduce((s, o) => s + o.value, 0n);
    const networkFee = spend.fixedOutputs ? totalIn - totalOut : 10_000n;
    const changeAddress = p2pkAddress(funding[0]?.owner ?? KEYS.trader);
    const asm = M.covenant.assembleFamilyTx(k, { spend, fundingEntries: funding, changeAddress, networkFee, networkId: NET });
    const unsignedJson = asm.transaction.serializeToSafeJSON();
    const idxs = [...asm.fundingInputIndexes, ...asm.tokenSignInputIndexes];
    const request = idxs.length ? M.spendV1.walletRequestV1(k, asm, spend, { networkId: NET }) : null;
    const dims = M.covenant.massDimsV1(k, asm.transaction, NET, idxs);
    const feeAt100 = M.covenant.feeForTxV1(k, asm.transaction, NET, 100, idxs);
    const signer = (tx, i) => { const who = asm.fundingInputIndexes.includes(i) ? funding[asm.fundingInputIndexes.indexOf(i)].owner : keyByPub.get(hex(spend.inputs[i].sign.holderPubkey)); return M.covenant.devKeySignerV1(k, who.pk)(tx, i); };
    const tx = await M.covenant.signFamilyTxV1(k, asm, spend, signer);
    const signedJson = tx.serializeToSafeJSON();
    out.push({ name, spend, asm, tx, unsignedJson, signedJson, masked: maskSigs(M, signedJson, asm), request, dims, feeAt100, describe: M.covenant.describeSpendV1(spend), confirm: M.spendV1.confirmSummaryV1(spend), meta: { f: asm.fundingInputIndexes, t: asm.tokenSignInputIndexes, totalIn: asm.totalIn, covenantOut: asm.covenantOut, change: asm.change } });
  }
  return out;
}
console.log('\n[3] production shapes: reference builders vs this SDK, same compiled programs, same inputs');
const ref = await runSide(R, T.ref), sdk = await runSide(D, T.sdk);
ok(ref.length === sdk.length && ref.length === 17, `${sdk.length} shapes built on both sides`);
for (let i = 0; i < Math.min(ref.length, sdk.length); i++) {
  const a = ref[i], b = sdk[i];
  ok(spendJson(a.spend) === spendJson(b.spend), `${a.name}: CovenantSpendV1 byte-identical (inputs, pre-scripted invocations, redeems, outputs, bindings, economics)`);
  ok(a.unsignedJson === b.unsignedJson, `${a.name}: assembled unsigned transaction byte-identical`);
  same(a.meta, b.meta, `${a.name}: index lists and totals`);
  ok(a.masked === b.masked, `${a.name}: signed transaction identical with signature bytes masked (witness placement, lengths, SIGHASH byte)`);
  same(a.describe, b.describe, `${a.name}: describeSpendV1`); same(a.confirm, b.confirm, `${a.name}: confirmSummaryV1`);
  same(a.request, b.request, `${a.name}: walletRequestV1 (KCC-12 §6.7 request)`);
  same(a.dims, b.dims, `${a.name}: massDimsV1`); same(a.feeAt100, b.feeAt100, `${a.name}: feeForTxV1 @100`);
  try { D.covenant.assertInvocationsV1(b.tx, b.spend); ok(D.covenant.withinCapsV1(b.dims), `${a.name}: SDK-signed tx passes assertInvocationsV1 and is within the mass caps (compute ${b.dims.compute})`); } catch (e) { ok(false, `${a.name}: SDK-signed tx structural check threw: ${e.message}`); }
  try { const r = D.spendV1.assertSighashAllV1(b.tx, b.asm); ok(r.length === b.asm.fundingInputIndexes.length + b.asm.tokenSignInputIndexes.length, `${a.name}: assertSighashAllV1 — ${r.map((x) => `${x.index}:${x.witness}`).join(' ') || 'no wallet signatures'}`); } catch (e) { ok(false, `${a.name}: assertSighashAllV1 threw: ${e.message}`); }
}

if (WRITE_FIXTURE) {
  const asServer = (c) => ({ name: c.name, bytecodeHex: c.bytecodeHex, stateSpan: c.stateSpan, prefixLen: c.prefix.length, suffixLen: c.suffix.length, templateHash: c.templateHash, dispatchTags: c.dispatchTags });
  let schema = null;
  const vdir = `${KRON}/covenants/kcc20v1/versions`;
  if (existsSync(vdir)) for (const d of readdirSync(vdir)) { try { const m = JSON.parse(readFileSync(join(vdir, d, 'manifest.json'), 'utf8')); if (m.templateHashes?.token === B.compiled.token.templateHash && m.templateHashes?.order === B.compiled.order.templateHash) schema = m.schema; } catch {} }
  const fx = {
    _comment: 'kcc20v1 family templates compiled by silverc v1.0.0 (WASM) from the archived reference sources for the test params below — what POST /api/native/kcc20v1-template answers for such a token. Regenerate: npm run build && node scripts/verify-parity-v1.mjs --write-fixture',
    family: 'kcc20v1', templateVersion: { family: 'kcc20v1', schema, silverc: null },
    keySeeds: Object.fromEntries(Object.entries(KEYS).map(([n, x]) => [n, { seed: Object.entries({ creator: 'c1', platform: 'c2', dev: 'c3', trader: 'b5', buyer2: 'b2', lp: 'b4' }).find(([kk]) => kk === n)[1], pubkey: x.hex }])),
    params: PARAMS,
    token: asServer(B.compiled.token), order: asServer(B.compiled.order), pool: asServer(B.compiled.pool), curve: asServer(B.compiled.curve),
  };
  writeFileSync(FIXTURE, JSON.stringify(fx, null, 1) + '\n');
  console.log(`\n  wrote ${FIXTURE.replace(SDK, '.')} (schema ${schema ? schema.slice(0, 12) + '…' : 'unknown'}, ${(Buffer.byteLength(JSON.stringify(fx)) / 1024).toFixed(0)} KB)`);
}

console.log(`\n${fails ? '✗ FAMILY PARITY CHECK FAILED' : '✓ FAMILY PARITY CHECK PASSED'} (${pass} passed, ${fails} failed)`);
process.exit(fails ? 1 : 0);
