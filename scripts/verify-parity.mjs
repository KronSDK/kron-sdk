// Parity guard — proves this SDK's curve builders produce BYTE-IDENTICAL transactions to the reference
// builders in the private kron monorepo (which are tested against the on-chain Kaspa txscript VM on testnet).
// This is the drift catcher: if a covenant change lands in kron without being mirrored here (or vice-versa),
// buy/sell/graduate stop matching and this FAILS — blocking a release that would build invalid transactions.
//
// It needs the kron reference repo + the silverc compiler checked out locally (they are NOT public).
// When they are missing this FAILS CLOSED (exit 1) — a release gate that cannot run must not report
// success. Environments that legitimately lack the private toolchain (external forks, public CI) opt
// out explicitly with KRON_PARITY_OPTIONAL=1, which skips with a notice and exits 0. The flag never
// excuses a missing dist/ (that's a forgotten `npm run build`), and it is a no-op when the toolchain
// IS present — it cannot be used to bypass a real parity mismatch. prepublishOnly runs WITHOUT the
// flag, so publishing from a machine that can't verify parity fails instead of silently passing.
//   • kron repo:  $KRON_REPO  (default: ../kron relative to this package)
//   • silverc:    $KRON_REPO/../projX/silverscript/target/debug/{silverc,cli-debugger}
// Run:  npm run verify:parity   (also runs automatically in prepublishOnly, after build)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SDK = resolve(here, '..');
const KRON = process.env.KRON_REPO ? resolve(process.env.KRON_REPO) : resolve(SDK, '../kron');
const PROJX = resolve(KRON, '../projX');
const SILVERC = `${PROJX}/silverscript/target/debug/silverc`;
const KWASM_JS = `${KRON}/web/src/vendor/kaspa/kaspa.js`;
const KWASM_BG = `${KRON}/web/src/vendor/kaspa/kaspa_bg.wasm`;
const REF_CURVE = `${KRON}/web/src/native/curveCpTx.ts`;
// KRN-SDK-POOL (0.13.1): the POOL builders were never gated here, only the curve — which is exactly how
// retainKasUnits drifted from the covenant's anti-partition ceiling to two nested floors and shipped a quote
// the VM rejects. Any exported function the SDK re-implements must have a reference here or it can rot.
// KRN-SDK-CURVE (0.14.1): the curve QUOTES were never gated either — only the curve BUILDERS above and the
// POOL quotes below. That gap is exactly how `quoteCpSell` shipped a NEGATIVE `net` into BOTH repos at once:
// each fee leg is padded to FEE_OUT_MIN, so on a small sell the fixed floor exceeds the gross payout and the
// seller pays to sell, while the only smallness guard bounds the GROSS.
const REF_CPCURVE = `${KRON}/web/src/cpCurve.ts`;
const REF_POOL = `${KRON}/web/src/native/poolCpTx.ts`;
const REF_POOL_V3 = `${KRON}/web/src/native/poolCpV3Tx.ts`;
const REF_BUDGETS = `${KRON}/web/src/native/covenantTxV1.ts`;   // per-input compute budgets live here, not in the builders
const REF_KCC20 = `${KRON}/web/src/native/kcc20Tx.ts`;
const SDK_DIST = `${SDK}/dist/index.js`;
const N = `${KRON}/covenants/native`;

if (!existsSync(SDK_DIST)) {
  console.error(`✗ PARITY CHECK FAILED — ${SDK_DIST.replace(SDK, '.')} not found. Run \`npm run build\` first.`);
  console.error(`  (Parity compares BUILT output; a missing build is not a missing toolchain, so`);
  console.error(`   KRON_PARITY_OPTIONAL does not skip this.)`);
  process.exit(1);
}
const missing = [SILVERC, KWASM_JS, REF_CURVE, REF_CPCURVE].filter((p) => !existsSync(p));
if (missing.length) {
  const detail = `missing: ${missing.map((p) => p.replace(SDK, '.')).join(', ')}`;
  if (process.env.KRON_PARITY_OPTIONAL === '1') {
    console.log(`⚠  PARITY CHECK SKIPPED (KRON_PARITY_OPTIONAL=1) — reference toolchain not found.`);
    console.log(`   ${detail}`);
    console.log(`   Parity was NOT verified. It is enforced at publish time (prepublishOnly runs without this flag).`);
    process.exit(0);
  }
  console.error(`✗ PARITY CHECK FAILED — reference toolchain not found and KRON_PARITY_OPTIONAL is not set.`);
  console.error(`   ${detail}`);
  console.error(`   Fix: set KRON_REPO=<path to the kron monorepo> (default: ../kron sibling), with silverc built`);
  console.error(`   at <kron>/../projX/silverscript/target/debug/silverc — or, in an environment that legitimately`);
  console.error(`   lacks the private toolchain (public CI, external fork), set KRON_PARITY_OPTIONAL=1 to skip.`);
  process.exit(1);
}

// --- load the kaspa WASM + both builder implementations -----------------------------------------
const kaspaMod = await import(pathToFileURL(KWASM_JS).href);
const kaspa = kaspaMod; const init = kaspaMod.default;
await init({ module_or_path: readFileSync(KWASM_BG) });
const M = await import(pathToFileURL(REF_CURVE).href);                 // reference builders (kron monorepo)
const { addressPresenceOwned, covenantIdOwned, IDENTIFIER } = await import(pathToFileURL(REF_KCC20).href);
const SDK_MOD = await import(pathToFileURL(SDK_DIST).href);
const S = SDK_MOD.curveCp;                                             // this SDK's built builders
const MP = await import(pathToFileURL(REF_POOL).href);                 // reference pool quotes (kron monorepo)
const MP3 = await import(pathToFileURL(REF_POOL_V3).href);             // reference v3 pool builders
const SP = SDK_MOD.poolCp ?? SDK_MOD;                                  // this SDK's pool quotes
const SP3 = SDK_MOD.poolCpV3 ?? SDK_MOD;                               // this SDK's v3 pool builders
const SPEND = SDK_MOD.spend ?? SDK_MOD;                                // per-input compute budget constants
const { COVENANT_ID } = IDENTIFIER;

// --- silverc helpers (compile the CURRENT covenant templates so the check tracks the live covenant) ---
let tmp = 0;
const hx = (b) => Buffer.from(b).toString('hex');
const bytesOf = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const I = (n) => ({ kind: 'int', data: Number(n) });
const Bo = (b) => ({ kind: 'bool', data: b });
const By = (n) => ({ kind: 'byte', data: Number(n) });
const arr = (buf) => ({ kind: 'array', data: [...buf].map((x) => ({ kind: 'byte', data: x })) });
function compile(sil, ctor) {
  const base = `/tmp/parity_${process.pid}_${tmp++}`;
  writeFileSync(`${base}.ctor`, JSON.stringify(ctor));
  execFileSync(SILVERC, [sil, '--constructor-args', `${base}.ctor`, '-o', `${base}.json`], { stdio: 'pipe' });
  return JSON.parse(readFileSync(`${base}.json`, 'utf8'));
}
function blake2b256(buf) {
  const p = `/tmp/parityb_${process.pid}_${tmp++}`; writeFileSync(p, Buffer.from(buf));
  return Buffer.from(execFileSync('python3', ['-c', 'import sys,hashlib;sys.stdout.write(hashlib.blake2b(open(sys.argv[1],"rb").read(),digest_size=32).hexdigest())', p], { encoding: 'utf8' }).trim(), 'hex');
}

const ZERO32 = new Uint8Array(32);
const tokGen = compile(`${N}/kcc20.sil`, [I(4), I(4), arr(ZERO32), By(COVENANT_ID), I(0), Bo(false)]);
const tokScript = Uint8Array.from(tokGen.script);
const { start: tokStart, len: tokLen } = tokGen.state_layout;
const tokPrefix = tokScript.slice(0, tokStart), tokSuffix = tokScript.slice(tokStart + tokLen);
const tplHash = blake2b256(Buffer.concat([Buffer.from(tokPrefix), Buffer.from(tokSuffix)]));
const tokenTpl = { script: tokScript, stateStart: tokStart, maxIns: 4, maxOuts: 4 };

const CREATOR = '01'.repeat(32), PLATFORM = '02'.repeat(32), CURVE_COVID = 'cc'.repeat(32), TOKEN_COVID = 'ab'.repeat(32), ZERO_COVID = '00'.repeat(32);
const BUYER = '03'.repeat(32), TRADER = '04'.repeat(32), DEV_FUND = '05'.repeat(32);
const DEX_C = 20, DEX_P = 10, LP_BPS = 20, POOL_LOCKED = 1000, devBps = 10;
const poolV2Ctor = [I(0), I(0), I(0), I(POOL_LOCKED), arr(bytesOf(TOKEN_COVID)), arr(tokPrefix), arr(tokSuffix), arr(tplHash), I(tokPrefix.length), I(tokSuffix.length), arr(bytesOf(ZERO_COVID)), arr(bytesOf(CREATOR)), arr(bytesOf(PLATFORM)), I(DEX_C), I(DEX_P), I(LP_BPS)];
const poolV2Gen = compile(`${N}/amm_pool_cp_v3.sil`, poolV2Ctor);
const poolV2Tpl = { script: Uint8Array.from(poolV2Gen.script), stateStart: poolV2Gen.state_layout.start };
const pPre = poolV2Tpl.script.slice(0, poolV2Tpl.stateStart), pSuf = poolV2Tpl.script.slice(poolV2Tpl.stateStart + poolV2Gen.state_layout.len);
const poolV2TplHash = blake2b256(Buffer.concat([Buffer.from(pPre), Buffer.from(pSuf)]));
// refundable buy_order.sil template — curve_cp bakes its hash + part lengths (batchBuy reads authenticated intents)
const orderGen = compile(`${N}/buy_order.sil`, [arr(tokPrefix), arr(tokSuffix), arr(tplHash), arr(ZERO32), arr(ZERO32), I(0), I(0)]);
const orderScript = Uint8Array.from(orderGen.script);
const oPre = orderScript.slice(0, orderGen.state_layout.start), oSuf = orderScript.slice(orderGen.state_layout.start + orderGen.state_layout.len);
const orderTplHash = blake2b256(Buffer.concat([Buffer.from(oPre), Buffer.from(oSuf)]));

const vKas = 5000, graduationKas = 5000000000, cB = 70, pB = 30, gB = 500;
// Current curve_cp ABI. Vesting was RETIRED from the covenant on 2026-08-01 — the four vesting ctor args
// (prefix/suffix/templateHash/total) and the initVested entrypoint are gone, so batchBuy moved from selector
// 5 to 4. Tail order is now: poolLockedShares, initTokenReserve, batch-order template, dev-fund leg LAST.
const curveCtor = [arr(bytesOf(CREATOR)), arr(bytesOf(PLATFORM)), arr(bytesOf(CREATOR)), I(vKas), I(graduationKas), I(cB), I(pB), I(gB), arr(bytesOf(ZERO_COVID)), arr(tokPrefix), arr(tokSuffix), arr(tplHash), I(tokPrefix.length), I(tokSuffix.length), arr(pPre), arr(pSuf), arr(poolV2TplHash), Bo(false), I(POOL_LOCKED), I(0), arr(orderTplHash), I(oPre.length), I(oSuf.length), arr(bytesOf(DEV_FUND)), I(devBps)];
const curveGen = compile(`${N}/curve_cp.sil`, curveCtor);
const baseParams = { creatorFeeOwner: bytesOf(CREATOR), platformFeeOwner: bytesOf(PLATFORM), vKas: BigInt(vKas), graduationKas: BigInt(graduationKas), creatorFeeBps: BigInt(cB), platformFeeBps: BigInt(pB), graduationFeeBps: BigInt(gB) };
// Dual-ABI: dev-fund tokens (every mainnet token) carry the third fee output at a FIXED covenant index;
// old-pinned tokens must NOT get one. Parity is checked on BOTH shapes — dropping the leg builds a tx the
// chain rejects, adding it to an old token silently donates the bps.
const curveTpl = { script: Uint8Array.from(curveGen.script), stateStart: curveGen.state_layout.start, params: { ...baseParams, devFundOwner: bytesOf(DEV_FUND), devFundBps: BigInt(devBps) } };
const curveTplLegacy = { script: curveTpl.script, stateStart: curveTpl.stateStart, params: baseParams };

// --- compare each op built by BOTH implementations, byte for byte -------------------------------
let fails = 0;
const spendHex = (s) => JSON.stringify({
  kind: s.kind,
  inputs: s.inputs.map((i) => ({ tx: i.transactionId, idx: i.index, val: String(i.value), spk: i.scriptPublicKey.script, sig: i.signatureScript, redeem: hx(i.redeem), role: i.role })),
  outputs: s.outputs.map((o) => ({ val: String(o.value), spk: o.scriptPublicKey.script, role: o.role })),
  covids: s.covids,
});
const cmp = (name, a, b) => {
  const eq = spendHex(a) === spendHex(b);
  console.log(`  ${eq ? 'PASS' : 'FAIL'}  ${name}`);
  if (!eq) { fails++; console.log('    ref:', spendHex(a).slice(0, 300)); console.log('    sdk:', spendHex(b).slice(0, 300)); }
};

console.log(`\nparity: SDK dist vs kron reference builders (curve template ${curveTpl.script.length}B @${curveTpl.stateStart})`);

// --- per-input compute budgets ------------------------------------------------------------------
// `computeBudget` is CONSENSUS-SERIALIZED (u16 per input, 100 grams of compute mass each) against an
// UNRAISABLE 500_000 cap. It is applied at ASSEMBLY, not by the builders, so it never appears in the
// spend comparison below — which is exactly how it drifted: KRON right-sized 2000/500 → 400/100 and the
// SDK kept the old values, silently building txs that exceed the compute cap. Compared here against the
// reference source directly (regex, not import — covenantTxV1.ts is browser-targeted).
{
  const ref = readFileSync(REF_BUDGETS, 'utf8');
  const refConst = (name) => Number(ref.match(new RegExp(`export const ${name} = (\\d+)`))?.[1]);
  for (const name of ['FUNDING_COMPUTE', 'TOKEN_COMPUTE', 'COVENANT_COMPUTE']) {
    const want = refConst(name), got = Number(S[name] ?? SPEND[name]);
    const eq = Number.isFinite(want) && want === got;
    console.log(`  ${eq ? 'PASS' : 'FAIL'}  ${name} (kron ${want} / sdk ${got})`);
    if (!eq) fails++;
  }
}
{
  const inv = { transactionId: '11'.repeat(32), index: 0, value: 1000n, amount: 500000n };
  const utxo = { transactionId: ZERO_COVID, index: 0, realKas: 0n, state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 500000n } };
  const a = [kaspa, curveTpl, tokenTpl, utxo, inv, bytesOf(CURVE_COVID), bytesOf(BUYER), 1000000n, 99n, [], 0, { tokenDust: 50_000_000n }];
  cmp('buy (dev-fund ABI)', M.buildCpBuy(...a), S.buildCpBuy(...a));
  const aL = [kaspa, curveTplLegacy, tokenTpl, utxo, inv, bytesOf(CURVE_COVID), bytesOf(BUYER), 1000000n, 99n, [], 0, { tokenDust: 50_000_000n }];
  cmp('buy (legacy two-fee ABI)', M.buildCpBuy(...aL), S.buildCpBuy(...aL));
}
{
  const inv = { transactionId: '22'.repeat(32), index: 0, value: 1000n, amount: 400000n };
  const utxo = { transactionId: ZERO_COVID, index: 0, realKas: 10000000n, state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 400000n } };
  const seller = { transactionId: '33'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(TRADER), 500n) };
  const a = [kaspa, curveTpl, tokenTpl, utxo, [seller], inv, bytesOf(CURVE_COVID), bytesOf(TRADER), 160n, 2000000n, 3, { tokenDust: 50_000_000n }];
  cmp('sell (fractional, change — dev-fund ABI)', M.buildCpSell(...a), S.buildCpSell(...a));
  const s2 = { transactionId: '33'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(TRADER), 160n) };
  const a2 = [kaspa, curveTpl, tokenTpl, utxo, [s2], inv, bytesOf(CURVE_COVID), bytesOf(TRADER), 160n, 2000000n, 3, { tokenDust: 50_000_000n }];
  cmp('sell (full-UTXO — dev-fund ABI)', M.buildCpSell(...a2), S.buildCpSell(...a2));
  // The dev-fund output sits at the FIXED index 4, so on a fractional sell the covid-A change shifts to [5].
  const aL = [kaspa, curveTplLegacy, tokenTpl, utxo, [seller], inv, bytesOf(CURVE_COVID), bytesOf(TRADER), 160n, 2000000n, 3, { tokenDust: 50_000_000n }];
  cmp('sell (fractional, change — legacy two-fee ABI)', M.buildCpSell(...aL), S.buildCpSell(...aL));
}
{
  const inv = { transactionId: '11'.repeat(32), index: 0, value: 1000n, amount: 2500n };
  const utxo = { transactionId: ZERO_COVID, index: 0, realKas: BigInt(graduationKas), state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 2500n } };
  const a = [kaspa, curveTpl, tokenTpl, poolV2Tpl, utxo, inv, bytesOf(CURVE_COVID), BigInt(POOL_LOCKED), { tokenDust: 50_000_000n }];
  cmp('graduate', M.buildCpGraduate(...a), S.buildCpGraduate(...a));
}

// --- curve buy/sell default-dust safety (KRN-SDK-DUST, extended to curveCpTx.ts) --------------------------
// buildCpBuy/buildCpSell/buildCpGraduate carried the same unsafe bare-1000n default as the pool builders —
// this SDK's 0.13.3 release fixed only the pool builders; the curve builders were still emitting sub-dust
// covenant token outputs. `ref` (kron's private reference, which always overrides tokenDust explicitly) is
// EXPECTED to stay at legacy 1000n here — that documents the reference is untouched, not a regression.
{
  console.log('\ncurve buy/sell default-dust safety (SDK vs kron reference)');
  const inv = { transactionId: '11'.repeat(32), index: 0, value: 1000n, amount: 500000n };
  const utxo = { transactionId: ZERO_COVID, index: 0, realKas: 0n, state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 500000n } };
  const a = [kaspa, curveTpl, tokenTpl, utxo, inv, bytesOf(CURVE_COVID), bytesOf(BUYER), 1000000n, 99n, [], 0];
  const ref = M.buildCpBuy(...a), sdk = S.buildCpBuy(...a);
  const buyerOutIdx = 2; // outputs: [curve(0), inventory(1), buyerOut(2), creatorFee, platformFee, ...] — buyerOut carries `dust`
  const okBuy = ref.outputs[buyerOutIdx].value === 1000n && sdk.outputs[buyerOutIdx].value === 50_000_000n;
  console.log(`  ${okBuy ? 'PASS' : 'FAIL'}  unset tokenDust on buy: reference stays at legacy 1000n, SDK now defaults to safe COVENANT_DUST (ref=${ref.outputs[buyerOutIdx].value} sdk=${sdk.outputs[buyerOutIdx].value})`);
  if (!okBuy) fails++;
}

// --- curve QUOTE parity + net-positivity invariant (KRN-SDK-CURVE) ------------------------------
// TWO checks, and they do DIFFERENT jobs. Keeping both is the point of this block:
//   (1) PARITY — ref vs sdk, full-object. Catches DRIFT (one repo patched, the other not). It would NOT have
//       caught the original negative-net bug: both copies were identically wrong, so parity passed clean.
//   (2) INVARIANT — reference-independent: a returned sell quote must have net > 0. THIS is the check that
//       catches a value-destroying quote, on either side, regardless of what the other side says.
// The sweep is deliberately dense in the SMALL-SELL band, where the padded fee floor dominates — a coarse
// log sweep of large trades never enters it, which is why nothing noticed for so long.
{
  console.log('\ncurve quote parity + net-positivity invariant (SDK vs kron reference)');
  const MC = await import(pathToFileURL(REF_CPCURVE).href);
  const SC = SDK_MOD.curve;
  const j = (q) => (q == null ? 'null' : JSON.stringify(q, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  // Both ABIs: the 2-leg legacy shape has a different floor (0.4 KAS) and so a different boundary.
  const abis = [
    ['3-leg dev-fund ABI', { creatorFeeBps: 25n, platformFeeBps: 90n, devFundBps: 10n }],
    ['2-leg legacy ABI', { creatorFeeBps: 25n, platformFeeBps: 90n }],
  ];
  // Live mainnet curve shapes — shallow reserves are the risk case.
  const shapes = [
    ['SOKKER-like (2.42 KAS raised)', 242_000_000n, 411_592_931n, 10_769_230n],
    ['CHONK-like (1.03 KAS raised)', 103_000_000n, 989_987_763n, 3_750_000n],
    ['NOSE-like (4.89 KAS raised)', 489_000_000n, 899_940_151n, 6_499_675n],
    ['deep curve (5000 KAS raised)', 500_000_000_000n, 600_000_000n, 6_250_000n],
    ['fresh curve (0 raised)', 0n, 1_000_000_000n, 6_250_000n],
  ];
  let checked = 0, drift = 0, nonPositive = 0, shown = 0;
  const say = (m) => { if (shown++ < 6) console.log(m); else if (shown === 7) console.log('  … (further violations suppressed)'); };
  for (const [label, realKas, tokenReserve, vKas] of shapes) for (const [abiName, bps] of abis) {
    const st = { realKas, tokenReserve, vKas, graduationKas: 25_000_000_000_000n, ...bps };
    const sizes = new Set();
    for (let e = 0; e <= 12; e++) { const b = 10n ** BigInt(e); for (const m of [1n, 2n, 5n, 7n]) sizes.add(b * m); }
    const step = tokenReserve / 100000n || 1n;                    // dense walk of the small-sell band
    for (let i = 1n; i <= 400n; i++) sizes.add(i * step);
    for (const tokenIn of [...sizes].sort((a, b) => (a < b ? -1 : 1))) {
      let a, b;
      try { a = MC.quoteCpSell(st, tokenIn); } catch { a = null; }
      try { b = SC.quoteCpSell(st, tokenIn); } catch { b = null; }
      checked++;
      if (j(a) !== j(b)) {
        drift++; fails++;
        say(`  FAIL  quoteCpSell drift — ${abiName} / ${label} tokenIn=${tokenIn}`);
      }
      // A sell whose net <= 0 hands the seller's tokens to the curve AND their KAS to the fee owners.
      // `null` is the contract for "not sellable"; a net<=0 OBJECT is a quote that destroys the caller's funds.
      for (const [side, q] of [['kron', a], ['sdk', b]]) {
        if (q && q.net <= 0n) {
          nonPositive++; fails++;
          say(`  FAIL  ${side} quoteCpSell returned net<=0 — ${abiName} / ${label} tokenIn=${tokenIn} kasOut=${q.kasOut} fee=${q.fee} net=${q.net}`);
        }
        if (q && (q.fee !== q.creatorFee + q.platformFee + q.devFundFee || q.net !== q.kasOut - q.fee)) {
          fails++; say(`  FAIL  ${side} quoteCpSell fee/net decomposition broken — ${abiName} / ${label} tokenIn=${tokenIn}`);
        }
      }
    }
    // minOutWithSlippage: same module, same export. An UNCLAMPED tolerance above 100% returns a NEGATIVE
    // floor, which silently disables the `quote.net < opts.minOut` slippage gate in the trade flows.
    for (const out of [0n, 1n, 1000n, 1_000_000_000n]) for (const bps of [-500, 0, 1, 100, 5000, 10000, 15000, 1e6]) {
      checked++;
      const a = String(MC.minOutWithSlippage(out, bps)), b = String(SC.minOutWithSlippage(out, bps));
      if (a !== b) { drift++; fails++; say(`  FAIL  minOutWithSlippage drift — out=${out} bps=${bps} kron=${a} sdk=${b}`); }
      if (BigInt(a) < 0n || BigInt(b) < 0n) { fails++; say(`  FAIL  minOutWithSlippage went NEGATIVE — out=${out} bps=${bps}`); }
    }
    // Buy side: no positivity hazard (the fee is charged ON TOP of kasIn), but the same padded-leg code path.
    for (const kas of [1n, 5n, 50n, 500n, 5000n, 50000n, 500000n]) {
      let a, b;
      try { a = MC.quoteCpBuy(st, kas * 1_000_000n); } catch { a = null; }
      try { b = SC.quoteCpBuy(st, kas * 1_000_000n); } catch { b = null; }
      checked++;
      if (j(a) !== j(b)) { drift++; fails++; say(`  FAIL  quoteCpBuy drift — ${abiName} / ${label} kasIn=${kas * 1_000_000n}`); }
    }
  }
  console.log(`  ${drift === 0 ? 'PASS' : 'FAIL'}  ${checked} curve quotes compared across ${shapes.length} shapes x ${abis.length} ABIs (drift=${drift})`);
  console.log(`  ${nonPositive === 0 ? 'PASS' : 'FAIL'}  net-positivity invariant: no returned sell quote has net<=0 (violations=${nonPositive})`);
}

// --- token-list canonicalizer parity (backend/tokenListSignature.mjs ↔ this SDK's verify module) --
// The signed token list's canonical message is a byte contract between the two repos: if either copy
// drifts, every partner's signature verification breaks. Checked with a real Schnorr round-trip using
// the kaspa WASM already loaded above.
{
  const T = await import(pathToFileURL(`${KRON}/backend/tokenListSignature.mjs`).href);
  const V = SDK_MOD.verify;
  const doc = {
    name: 'KRON', timestamp: '2026-01-01T00:00:00.000Z', version: { major: 1, minor: 1, patch: 2 },
    network: 'mainnet', keywords: ['kron'], variant: { all: false, tier: null },
    tokens: [{ network: 'mainnet', covenantId: 'aa'.repeat(32), symbol: 'TKN', name: 'Token', decimals: 0, extensions: { genesisTxid: 'cc'.repeat(32), curveParams: { vKas: 5000 } } }],
  };
  const eq = T.canonicalTokenListMsg(doc) === V.canonicalTokenListMsg(doc);
  console.log(`  ${eq ? 'PASS' : 'FAIL'}  tokenlist canonicalizer byte-parity (backend ↔ SDK)`);
  if (!eq) fails++;
  const kp = kaspa.Keypair.random();
  const signed = T.signTokenList(doc, { all: false, tier: null }, { kaspa, privateKey: kp.privateKey, publicKey: String(kp.xOnlyPublicKey) });
  const ok = V.verifyTokenListSignature(kaspa, signed, { pinnedPublicKey: String(kp.xOnlyPublicKey) });
  const tampered = V.verifyTokenListSignature(kaspa, { ...signed, tokens: [{ ...signed.tokens[0], symbol: 'EVIL' }] }, { pinnedPublicKey: String(kp.xOnlyPublicKey) });
  const rt = ok.ok === true && tampered.ok === false;
  console.log(`  ${rt ? 'PASS' : 'FAIL'}  tokenlist sign (backend) → verify (SDK) round-trip + tamper-fails`);
  if (!rt) fails++;
}

// --- POOL QUOTES (KRN-SDK-POOL): the numeric path the covenant enforces -----------------------------
// The builders were already identical; what drifted was the QUOTE feeding them. `retainKasUnits` is the
// covenant's anti-partition ceiling, and a one-unit error there makes the VM reject on
// `require((newKas - retainKas) * newToken >= oldK)`. Compare the quotes numerically over a spread of pool
// shapes and trade sizes — a single canonical case would miss it, because whether the off-by-one crosses a
// ceiling boundary is state-dependent (probability ≈ tokenReserve/kasReserve).
{
  console.log('\npool quote parity (SDK vs kron reference) — the path that rejected 0.13.0 pool swaps');
  const SCALE_ = 1000000n;
  const shapes = [
    { kasReserve: 78763432n, tokenReserve: 31891357n, totalShares: 1149416n, lockedShares: 1000000n }, // live KRON
    { kasReserve: 207917n,   tokenReserve: 96843443n, totalShares: 1000000n, lockedShares: 1000000n }, // live PEPE (token-heavy)
    { kasReserve: 500000n,   tokenReserve: 500000n,   totalShares: 2000000n, lockedShares: 1000000n }, // 50% voluntary
    { kasReserve: 1000000n,  tokenReserve: 40000000n, totalShares: 1000001n, lockedShares: 1000000n }, // 1 voluntary share
  ];
  const params = { creatorFeeBps: 10n, platformFeeBps: 70n, lpFeeBps: 20n, lockedShares: 1000000n };
  let checked = 0, bad = 0;
  for (const sh of shapes) {
    const st = { ...sh, tokenCovid: new Uint8Array(32), lpCovid: new Uint8Array(32) };
    const p = { ...params, lockedShares: sh.lockedShares };
    for (const kas of [1n, 5n, 50n, 500n, 5000n, 50000n]) {
      const inSompi = kas * SCALE_;
      for (const [label, refFn, sdkFn] of [
        ['quotePoolCpBuy', MP.quotePoolCpBuy, SP.quotePoolCpBuy ?? SP3.quotePoolV3Buy],
        ['quotePoolCpSell', MP.quotePoolCpSell, SP.quotePoolCpSell ?? SP3.quotePoolV3Sell],
      ]) {
        if (typeof refFn !== 'function' || typeof sdkFn !== 'function') continue;
        let a, b;
        try { a = refFn(st, p, inSompi); } catch { a = null; }
        try { b = sdkFn(st, p, inSompi); } catch { b = null; }
        checked++;
        const j = (q) => (q == null ? 'null' : JSON.stringify(q, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
        if (j(a) !== j(b)) {
          bad++; fails++;
          console.log(`  FAIL  ${label} kas=${kas} kR=${sh.kasReserve} tR=${sh.tokenReserve}`);
          console.log('    ref:', j(a).slice(0, 220));
          console.log('    sdk:', j(b).slice(0, 220));
        }
      }
    }
  }
  console.log(`  ${bad === 0 ? 'PASS' : 'FAIL'}  ${checked} pool quotes compared across ${shapes.length} pool shapes`);
}

// --- POOL LIQUIDITY BUILDERS (KRN-SDK-POOL-LP): buildAddLiquidity / buildRemoveLiquidity byte-for-byte -----
// buildAddLiquidity was already correct; buildRemoveLiquidity previously built the pre-restructure ARCHIVED
// shape unconditionally (no pool-inventory input, poolLpOut = dShares) — rejected by every CURRENT-schema
// pool, i.e. every live pool. The reference builder here is KRON's own web/src/native/poolCpTx.ts, whose
// removeLiquidity output is independently VM-proven by covenants/native/tools/verify-builders-cp-v3.mjs (the
// dual-sided case) and covenants/native/tools/verify-pool-cp-v3.mjs (the zero-token-side case) — so
// byte-identity to it is byte-identity to a builder the real txscript VM has already accepted.
// The reference's OWN quoteRemoveLiquidity feeds both builders here, so this isolates BUILDER parity from the
// quote-numeric parity already checked above.
{
  console.log('\npool liquidity builder parity (SDK vs kron reference) — buildAddLiquidity / buildRemoveLiquidity');
  const poolCovid = bytesOf('ee'.repeat(32));
  const lpPubkey = bytesOf(BUYER);
  const poolTplCanonical = { script: poolV2Tpl.script, stateStart: poolV2Tpl.stateStart, canonicalInventoryRequired: true };
  const lpParams = { lockedShares: BigInt(POOL_LOCKED) };

  const mkState = (kasReserve, tokenReserve, totalShares) => ({
    kasReserve, tokenReserve, totalShares, tokenCovid: bytesOf(TOKEN_COVID), lpCovid: bytesOf('dd'.repeat(32)),
  });

  // addLiquidity: one representative deposit.
  {
    const state = mkState(4040n, 202000n, 1010n);
    const q = MP.quoteAddLiquidity(state, 40n);
    const invIn = 10_000_000n - state.totalShares;
    const utxo = { transactionId: '55'.repeat(32), index: 0, state, tokenUtxo: { transactionId: '66'.repeat(32), index: 0, value: 1000n } };
    const lpInv = { transactionId: '88'.repeat(32), index: 0, value: 1000n, amount: invIn };
    const lpDeposit = { transactionId: '99'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), q.dToken) };
    // Explicit tokenDust on BOTH sides: this tests BUILDER STRUCTURE, independent of either side's default (the
    // SDK's default now deliberately diverges from the reference's — see the dust-default section below).
    // `lpBindVerified: true` is the harness asserting the pool is honest, not a claim about any real pool. This
    // section compares BUILDER STRUCTURE byte-for-byte; the counterfeit-LP gate itself is covered by
    // src/client/lpBindIntegrity.test.ts. Since 0.17.0 the option is required and fails closed, so omitting it
    // here would throw before either builder ran. The reference builder ignores the extra key.
    const args = [kaspa, poolTplCanonical, tokenTpl, utxo, lpInv, poolCovid, lpDeposit, lpPubkey, q, 4, { tokenDust: 50_000_000n, lpBindVerified: true }];
    cmp('addLiquidity', MP.buildAddLiquidity(...args), SP.buildAddLiquidity(...args));
  }

  // removeLiquidity: dual-sided (both dKas and dToken positive) — the shape KRON's own VM suite proves directly.
  {
    const state = mkState(4040n, 202000n, 1010n);
    const q = MP.quoteRemoveLiquidity(state, lpParams, 10n);
    const oldInventory = 10_000_000n - state.totalShares;
    const utxo = { transactionId: '55'.repeat(32), index: 0, state, tokenUtxo: { transactionId: '66'.repeat(32), index: 0, value: 1000n } };
    const lpShares = { transactionId: 'aa'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), q.dShares) };
    const lpInventory = { transactionId: '88'.repeat(32), index: 0, value: 1000n, amount: oldInventory };
    const args = [kaspa, poolTplCanonical, tokenTpl, utxo, lpShares, poolCovid, lpPubkey, q, 4, { lpInventory, tokenDust: 50_000_000n }];
    cmp('removeLiquidity (dual-sided)', MP.buildRemoveLiquidity(...args), SP.buildRemoveLiquidity(...args));
  }

  // removeLiquidity: single-sided (dToken floors to zero on a token-heavy pool) — proves the SDK correctly
  // OMITS the LP-token output and its aStates/witness entry, matching KRON's own zero-sided-floor VM proof
  // (covenants/native/tools/verify-pool-cp-v3.mjs "remove_zero_token_side_ok").
  {
    const state = mkState(1_000_000_000n, 1n, 1_000_001n);   // token-heavy pool inverted: KAS side stays positive
    const q = MP.quoteRemoveLiquidity(state, lpParams, 1n);   // dKas floors to 999, dToken floors to 0
    if (q.dToken !== 0n) throw new Error(`fixture no longer floors dToken to zero (got ${q.dToken}) — adjust the state`);
    const oldInventory = 10_000_000n - state.totalShares;
    const utxo = { transactionId: '55'.repeat(32), index: 0, state, tokenUtxo: { transactionId: '66'.repeat(32), index: 0, value: 1000n } };
    const lpShares = { transactionId: 'aa'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), q.dShares) };
    const lpInventory = { transactionId: '88'.repeat(32), index: 0, value: 1000n, amount: oldInventory };
    const args = [kaspa, poolTplCanonical, tokenTpl, utxo, lpShares, poolCovid, lpPubkey, q, 4, { lpInventory, tokenDust: 50_000_000n }];
    const ref = MP.buildRemoveLiquidity(...args), sdk = SP.buildRemoveLiquidity(...args);
    cmp('removeLiquidity (single-sided, zero token)', ref, sdk);
    const refHasLpToken = ref.outputs.some((o) => o.role === 'lpToken');
    const sdkHasLpToken = sdk.outputs.some((o) => o.role === 'lpToken');
    console.log(`  ${!refHasLpToken && !sdkHasLpToken ? 'PASS' : 'FAIL'}  both omit the LP-token output when dToken=0 (ref=${refHasLpToken} sdk=${sdkHasLpToken})`);
    if (refHasLpToken || sdkHasLpToken) fails++;
  }
}

// --- POOL SWAP BUILDERS + DUST DEFAULT (KRN-SDK-DUST): buildPoolV3SwapKasForToken/TokenForKas -------------
// The swap builders were never compared byte-for-byte at all (only the QUOTES feeding them, above). Two
// checks per direction:
//   (1) STRUCTURAL parity with explicit, IDENTICAL tokenDust on both sides — proves the builders themselves
//       (input/output shape, redeem bytes, sig bytes) are unchanged, independent of either side's default.
//   (2) The DELIBERATE default divergence: the private kron reference (reused internally by an app that
//       ALWAYS overrides tokenDust explicitly) still defaults to the historical bare 1000n — below the KIP-9
//       storage-mass-safe floor. This SDK's public builders now default to COVENANT_DUST (50,000,000 sompi)
//       instead, because a public caller has no reason to know the private app's convention, and a silent
//       sub-dust build is covenant-VALID while being absurdly expensive to relay. `ref` staying at 1000n here
//       is EXPECTED and correct — it documents that the reference is untouched, not a regression.
{
  console.log('\npool swap builder parity + dust-default safety (SDK vs kron reference)');
  const poolCovid = bytesOf('ee'.repeat(32));
  const traderPubkey = bytesOf(BUYER);
  const poolTplCanonical = { script: poolV2Tpl.script, stateStart: poolV2Tpl.stateStart };
  const swapState = { kasReserve: 78763432n, tokenReserve: 31891357n, totalShares: 1149416n, tokenCovid: bytesOf(TOKEN_COVID), lpCovid: bytesOf('dd'.repeat(32)) };
  const swapParams = { creatorFeeOwner: bytesOf(CREATOR), platformFeeOwner: bytesOf(PLATFORM), creatorFeeBps: 10n, platformFeeBps: 70n, lpFeeBps: 20n, lockedShares: 1000000n };

  // buy
  {
    const utxo = { transactionId: '77'.repeat(32), index: 0, state: swapState, tokenUtxo: { transactionId: '78'.repeat(32), index: 0, value: 1000n } };
    const q = MP.quotePoolCpBuy(swapState, swapParams, 50n * 1_000_000n);
    const structArgs = [kaspa, poolTplCanonical, tokenTpl, swapParams, utxo, poolCovid, traderPubkey, q, [], 0, { tokenDust: 50_000_000n }];
    cmp('swapKasForToken (structure, explicit equal dust)', MP3.buildPoolV3SwapKasForToken(...structArgs), SP3.buildPoolV3SwapKasForToken(...structArgs));

    const defaultArgs = [kaspa, poolTplCanonical, tokenTpl, swapParams, utxo, poolCovid, traderPubkey, q, [], 0];
    const ref = MP3.buildPoolV3SwapKasForToken(...defaultArgs), sdk = SP3.buildPoolV3SwapKasForToken(...defaultArgs);
    const okDefault = ref.outputs[1].value === 1000n && ref.outputs[2].value === 1000n && sdk.outputs[1].value === 50_000_000n && sdk.outputs[2].value === 50_000_000n;
    console.log(`  ${okDefault ? 'PASS' : 'FAIL'}  unset tokenDust: reference stays at legacy 1000n (unchanged), SDK now defaults to safe COVENANT_DUST (ref pool=${ref.outputs[1].value} trader=${ref.outputs[2].value}; sdk pool=${sdk.outputs[1].value} trader=${sdk.outputs[2].value})`);
    if (!okDefault) fails++;
  }

  // sell
  {
    const utxo = { transactionId: '79'.repeat(32), index: 0, state: swapState, tokenUtxo: { transactionId: '7a'.repeat(32), index: 0, value: 1000n } };
    const q = MP.quotePoolCpSell(swapState, swapParams, 500000n);
    const traderTokens = [{ transactionId: '7b'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), 500000n) }];
    const structArgs = [kaspa, poolTplCanonical, tokenTpl, swapParams, utxo, poolCovid, traderPubkey, traderTokens, q, 0, { tokenDust: 50_000_000n }];
    cmp('swapTokenForKas (structure, explicit equal dust)', MP3.buildPoolV3SwapTokenForKas(...structArgs), SP3.buildPoolV3SwapTokenForKas(...structArgs));

    const defaultArgs = [kaspa, poolTplCanonical, tokenTpl, swapParams, utxo, poolCovid, traderPubkey, traderTokens, q, 0];
    const ref = MP3.buildPoolV3SwapTokenForKas(...defaultArgs), sdk = SP3.buildPoolV3SwapTokenForKas(...defaultArgs);
    const okDefault = ref.outputs[1].value === 1000n && sdk.outputs[1].value === 50_000_000n;
    console.log(`  ${okDefault ? 'PASS' : 'FAIL'}  unset tokenDust on the sell side too (ref=${ref.outputs[1].value}, expected legacy 1000n; sdk=${sdk.outputs[1].value}, expected safe 50,000,000n)`);
    if (!okDefault) fails++;
  }
}

// --- RECIPIENT-BOUND SCHEMA ABI (HLK-L04 curve / HLK-L12 pool) + HLK-L07 zero-payout burn -----------------
// The Hashlock fix schema (`bdbcfb2540d1…`) changed the buy/sell and pool entrypoint ABIs: every value-
// releasing entrypoint takes an appended (witness, identifier) recipient pair, and the two KAS-releasing pool
// legs (swapTokenForKas / removeLiquidity) pin the trader/LP KAS proceeds as an explicit P2PK output. All of
// it is gated on per-template discriminators (`recipientBound` / `zeroRemoveAllowed`), absent ⇒ legacy ABI —
// which is exactly why every fixture ABOVE kept passing while the SDK lacked the new ABI entirely: they all
// pass legacy templates. These fixtures set the flags and compare the NEW ABI byte-for-byte, plus
// reference-independent invariants on the parts an identically-wrong pair could hide.
{
  console.log('\nrecipient-bound schema ABI parity (HLK-L04 / HLK-L12 / HLK-L07) — the fix-schema builders');
  const SCALE_ = 1000000n;
  const poolCovid = bytesOf('ee'.repeat(32));
  const curveTplRB = { ...curveTpl, recipientBound: true };
  const poolTplRB = { script: poolV2Tpl.script, stateStart: poolV2Tpl.stateStart, recipientBound: true };
  const poolTplRBCanonical = { ...poolTplRB, canonicalInventoryRequired: true, zeroRemoveAllowed: true };
  const swapState = { kasReserve: 78763432n, tokenReserve: 31891357n, totalShares: 1149416n, tokenCovid: bytesOf(TOKEN_COVID), lpCovid: bytesOf('dd'.repeat(32)) };
  const swapParams = { creatorFeeOwner: bytesOf(CREATOR), platformFeeOwner: bytesOf(PLATFORM), creatorFeeBps: 10n, platformFeeBps: 70n, lpFeeBps: 20n, lockedShares: 1000000n };
  const lpParams = { lockedShares: BigInt(POOL_LOCKED) };
  // Both sides must REFUSE a recipient witness pointing at a covenant input — the covenant's presence proof
  // can never accept one, so building it would only defer the failure to a VM rejection.
  const throwsBoth = (name, fa, fb) => {
    let ra = false, rb = false;
    try { fa(); } catch { ra = true; }
    try { fb(); } catch { rb = true; }
    console.log(`  ${ra && rb ? 'PASS' : 'FAIL'}  ${name} (ref ${ra ? 'threw' : 'BUILT'}, sdk ${rb ? 'threw' : 'BUILT'})`);
    if (!(ra && rb)) fails++;
  };

  // curve buy/sell (HLK-L04): the appended (witness, identifier) pair in the curve sigscript.
  {
    const inv = { transactionId: '11'.repeat(32), index: 0, value: 1000n, amount: 500000n };
    const utxo = { transactionId: ZERO_COVID, index: 0, realKas: 0n, state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 500000n } };
    const buyArgs = (w) => [kaspa, curveTplRB, tokenTpl, utxo, inv, bytesOf(CURVE_COVID), bytesOf(BUYER), 1000000n, 99n, [], w, { tokenDust: 50_000_000n }];
    cmp('curve buy (recipient-bound)', M.buildCpBuy(...buyArgs(2)), S.buildCpBuy(...buyArgs(2)));
    throwsBoth('curve buy redirect attempt refused (witness at a covenant input)', () => M.buildCpBuy(...buyArgs(1)), () => S.buildCpBuy(...buyArgs(1)));

    const sUtxo = { transactionId: ZERO_COVID, index: 0, realKas: 10000000n, state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 400000n } };
    const sInv = { transactionId: '22'.repeat(32), index: 0, value: 1000n, amount: 400000n };
    const seller = { transactionId: '33'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(TRADER), 500n) };
    const sellArgs = (w) => [kaspa, curveTplRB, tokenTpl, sUtxo, [seller], sInv, bytesOf(CURVE_COVID), bytesOf(TRADER), 160n, 2000000n, w, { tokenDust: 50_000_000n }];
    cmp('curve sell (recipient-bound, fractional change)', M.buildCpSell(...sellArgs(3)), S.buildCpSell(...sellArgs(3)));
    throwsBoth('curve sell redirect attempt refused', () => M.buildCpSell(...sellArgs(2)), () => S.buildCpSell(...sellArgs(2)));
    // Full-UTXO sell under recipientBound: the placeholder traderChangeOut is still pushed in the sigscript
    // BEFORE the appended recipient pair while the change output is omitted — a distinct branch from the
    // fractional case above (the legacy section pins its own full-UTXO fixture; this is the RB twin).
    const s2 = { transactionId: '33'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(TRADER), 160n) };
    const fullArgs = [kaspa, curveTplRB, tokenTpl, sUtxo, [s2], sInv, bytesOf(CURVE_COVID), bytesOf(TRADER), 160n, 2000000n, 3, { tokenDust: 50_000_000n }];
    cmp('curve sell (recipient-bound, full-UTXO)', M.buildCpSell(...fullArgs), S.buildCpSell(...fullArgs));
  }

  // pool swaps (HLK-L12): the appended pair + the pinned trader KAS leg at SWAP_KAS_OUT=4 on the sell side.
  {
    const utxo = { transactionId: '77'.repeat(32), index: 0, state: swapState, tokenUtxo: { transactionId: '78'.repeat(32), index: 0, value: 1000n } };
    const qBuy = MP.quotePoolCpBuy(swapState, swapParams, 50n * SCALE_);
    const buyArgs = (w) => [kaspa, poolTplRB, tokenTpl, swapParams, utxo, poolCovid, bytesOf(BUYER), qBuy, [], w, { tokenDust: 50_000_000n }];
    cmp('swapKasForToken (recipient-bound)', MP3.buildPoolV3SwapKasForToken(...buyArgs(2)), SP3.buildPoolV3SwapKasForToken(...buyArgs(2)));
    throwsBoth('swapKasForToken redirect attempt refused', () => MP3.buildPoolV3SwapKasForToken(...buyArgs(1)), () => SP3.buildPoolV3SwapKasForToken(...buyArgs(1)));

    // FRACTIONAL sell (600000 in, 500000 folded) so the full recipient-bound layout is exercised: the KAS leg
    // at SWAP_KAS_OUT=4 AND the trader change shifted to 5 (legacy put change at 4).
    const qSell = MP.quotePoolCpSell(swapState, swapParams, 500000n);
    const traderTokens = [{ transactionId: '7b'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), 600000n) }];
    const sellArgs = (w) => [kaspa, poolTplRB, tokenTpl, swapParams, utxo, poolCovid, bytesOf(BUYER), traderTokens, qSell, w, { tokenDust: 50_000_000n }];
    const ref = MP3.buildPoolV3SwapTokenForKas(...sellArgs(3)), sdk = SP3.buildPoolV3SwapTokenForKas(...sellArgs(3));
    cmp('swapTokenForKas (recipient-bound)', ref, sdk);
    throwsBoth('swapTokenForKas redirect attempt refused', () => MP3.buildPoolV3SwapTokenForKas(...sellArgs(2)), () => SP3.buildPoolV3SwapTokenForKas(...sellArgs(2)));
    // Reference-independent invariant (an identically-wrong pair would pass cmp): the trader's KAS proceeds
    // are output 4, floored against the RAW bps fees — not the padded fee outputs, not builder-chosen change.
    const leg = sdk.outputs[4];
    const okLeg = leg?.role === 'traderKas' && leg.value === qSell.kasOut - qSell.creatorFee - qSell.platformFee
      && sdk.outputs[5]?.role === 'trader';
    console.log(`  ${okLeg ? 'PASS' : 'FAIL'}  trader KAS leg pinned at output 4 = kasOut − raw fees (got role=${leg?.role} value=${leg?.value}, expected ${qSell.kasOut - qSell.creatorFee - qSell.platformFee}); change follows at 5`);
    if (!okLeg) fails++;
  }

  // pool LP ops (HLK-L12): recipient pair on add/remove + the pinned LP KAS leg at REMOVE_KAS_OUT=2.
  {
    const mkState = (kasReserve, tokenReserve, totalShares) => ({ kasReserve, tokenReserve, totalShares, tokenCovid: bytesOf(TOKEN_COVID), lpCovid: bytesOf('dd'.repeat(32)) });
    const state = mkState(4040n, 202000n, 1010n);
    const utxo = { transactionId: '55'.repeat(32), index: 0, state, tokenUtxo: { transactionId: '66'.repeat(32), index: 0, value: 1000n } };
    const lpInv = { transactionId: '88'.repeat(32), index: 0, value: 1000n, amount: 10_000_000n - state.totalShares };

    const qAdd = MP.quoteAddLiquidity(state, 40n);
    const lpDeposit = { transactionId: '99'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), qAdd.dToken) };
    const addArgs = (w) => [kaspa, poolTplRBCanonical, tokenTpl, utxo, lpInv, poolCovid, lpDeposit, bytesOf(BUYER), qAdd, w, { tokenDust: 50_000_000n, lpBindVerified: true }];
    cmp('addLiquidity (recipient-bound)', MP.buildAddLiquidity(...addArgs(4)), SP.buildAddLiquidity(...addArgs(4)));
    throwsBoth('addLiquidity redirect attempt refused', () => MP.buildAddLiquidity(...addArgs(3)), () => SP.buildAddLiquidity(...addArgs(3)));

    const qRem = MP.quoteRemoveLiquidity(state, lpParams, 10n);
    const lpShares = { transactionId: 'aa'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), qRem.dShares) };
    const remArgs = (w) => [kaspa, poolTplRBCanonical, tokenTpl, utxo, lpShares, poolCovid, bytesOf(BUYER), qRem, w, { lpInventory: lpInv, tokenDust: 50_000_000n }];
    const ref = MP.buildRemoveLiquidity(...remArgs(4)), sdk = SP.buildRemoveLiquidity(...remArgs(4));
    cmp('removeLiquidity (recipient-bound, dual-sided)', ref, sdk);
    throwsBoth('removeLiquidity redirect attempt refused', () => MP.buildRemoveLiquidity(...remArgs(3)), () => SP.buildRemoveLiquidity(...remArgs(3)));
    // Invariant: the LP's KAS is output 2 (AFTER the reserve, so reserve.index−1 pool-pointer derivation
    // holds) and equals dKas·SCALE exactly.
    const leg = sdk.outputs[2];
    const okLeg = sdk.outputs[1]?.role === 'poolToken' && leg?.role === 'lpKas' && leg.value === qRem.dKas * SCALE_;
    console.log(`  ${okLeg ? 'PASS' : 'FAIL'}  LP KAS leg pinned at output 2 = dKas·SCALE, reserve stays at output 1 (got role=${leg?.role} value=${leg?.value}, expected ${qRem.dKas * SCALE_})`);
    if (!okLeg) fails++;

    // SINGLE-SIDED removes under recipientBound — the layout branches unique to the new ABI, where the two
    // conditional spreads interleave (`lpKas` iff dKas>0, `lpToken` iff dToken>0). Neither combination is
    // pinned anywhere else: kron's VM suite hand-rolls the one-sided tx JSON rather than calling the builder,
    // and the legacy single-sided fixture above doesn't set recipientBound — so a composition drift here
    // would ship with every other gate green. Both combinations occur on live pool shapes (token-heavy pools
    // floor dKas to 0 on small withdrawals; inverted pools floor dToken to 0).
    {
      // dKas>0 / dToken=0: KAS leg at 2, NO lpToken, inventory last.
      const st = mkState(1_000_000_000n, 1n, 1_000_001n);
      const q = MP.quoteRemoveLiquidity(st, lpParams, 1n);
      if (q.dToken !== 0n || q.dKas === 0n) throw new Error('fixture no longer floors dToken to zero — adjust the state');
      const u = { transactionId: '55'.repeat(32), index: 0, state: st, tokenUtxo: { transactionId: '66'.repeat(32), index: 0, value: 1000n } };
      const inv = { transactionId: '88'.repeat(32), index: 0, value: 1000n, amount: 10_000_000n - st.totalShares };
      const sh = { transactionId: 'aa'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), q.dShares) };
      const a = [kaspa, poolTplRBCanonical, tokenTpl, u, sh, poolCovid, bytesOf(BUYER), q, 4, { lpInventory: inv, tokenDust: 50_000_000n }];
      const r = MP.buildRemoveLiquidity(...a), s = SP.buildRemoveLiquidity(...a);
      cmp('removeLiquidity (recipient-bound, single-sided dToken=0)', r, s);
      const ok = s.outputs[2]?.role === 'lpKas' && s.outputs[2].value === q.dKas * SCALE_
        && !s.outputs.some((o) => o.role === 'lpToken') && s.outputs[s.outputs.length - 1]?.role === 'poolLpInventory';
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  dToken=0: KAS leg at 2, lpToken omitted, inventory last`);
      if (!ok) fails++;
    }
    {
      // dKas=0 / dToken>0: NO KAS leg, lpToken directly after the reserve at 2.
      const st = mkState(1n, 1_000_000_000n, 1_000_001n);
      const q = MP.quoteRemoveLiquidity(st, lpParams, 1n);
      if (q.dKas !== 0n || q.dToken === 0n) throw new Error('fixture no longer floors dKas to zero — adjust the state');
      const u = { transactionId: '55'.repeat(32), index: 0, state: st, tokenUtxo: { transactionId: '66'.repeat(32), index: 0, value: 1000n } };
      const inv = { transactionId: '88'.repeat(32), index: 0, value: 1000n, amount: 10_000_000n - st.totalShares };
      const sh = { transactionId: 'aa'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), q.dShares) };
      const a = [kaspa, poolTplRBCanonical, tokenTpl, u, sh, poolCovid, bytesOf(BUYER), q, 4, { lpInventory: inv, tokenDust: 50_000_000n }];
      const r = MP.buildRemoveLiquidity(...a), s = SP.buildRemoveLiquidity(...a);
      cmp('removeLiquidity (recipient-bound, single-sided dKas=0)', r, s);
      const ok = !s.outputs.some((o) => o.role === 'lpKas') && s.outputs[2]?.role === 'lpToken';
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  dKas=0: no KAS leg, lpToken directly after the reserve`);
      if (!ok) fails++;
    }

    // HLK-L07 zero-payout burn: on a shares-heavy pool a small redemption floors BOTH sides to zero; the fix
    // schema accepts it (shares burn to inventory) with NO KAS leg and NO lpToken output — legacy layout.
    const heavy = mkState(1000n, 2000n, 1_000_000n);
    const hUtxo = { transactionId: '55'.repeat(32), index: 0, state: heavy, tokenUtxo: { transactionId: '66'.repeat(32), index: 0, value: 1000n } };
    const hInv = { transactionId: '88'.repeat(32), index: 0, value: 1000n, amount: 10_000_000n - heavy.totalShares };
    const qa = MP.quoteRemoveLiquidity(heavy, lpParams, 499n, { allowZeroPayout: true });
    const qb = SP.quoteRemoveLiquidity(heavy, lpParams, 499n, { allowZeroPayout: true });
    const j = (q) => JSON.stringify(q, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    console.log(`  ${j(qa) === j(qb) ? 'PASS' : 'FAIL'}  quoteRemoveLiquidity allowZeroPayout parity (dKas=${qa.dKas} dToken=${qa.dToken})`);
    if (j(qa) !== j(qb)) fails++;
    const hShares = { transactionId: 'aa'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), qa.dShares) };
    const hArgs = [kaspa, poolTplRBCanonical, tokenTpl, hUtxo, hShares, poolCovid, bytesOf(BUYER), qa, 4, { lpInventory: hInv, tokenDust: 50_000_000n }];
    const hRef = MP.buildRemoveLiquidity(...hArgs), hSdk = SP.buildRemoveLiquidity(...hArgs);
    cmp('removeLiquidity (recipient-bound, HLK-L07 zero-payout burn)', hRef, hSdk);
    const noLegs = !hSdk.outputs.some((o) => o.role === 'lpKas' || o.role === 'lpToken');
    console.log(`  ${noLegs ? 'PASS' : 'FAIL'}  zero-payout burn emits no KAS leg and no lpToken output (legacy layout)`);
    if (!noLegs) fails++;
  }

  // PADDED-CARRIER fixtures — the round-1 parity gap. Every fixture above feeds a covenant carrier worth
  // ≤ dust, where continuationValue(dust, input) === dust, so a builder that regressed to emitting the bare
  // constant would stay byte-identical and pass. These feed a PADDED carrier (input > dust) and pin, both by
  // parity and by invariant, that the continuation tracks the input.
  {
    const PAD = 123_456_789n;   // > the 50,000,000n explicit dust
    const inv = { transactionId: '11'.repeat(32), index: 0, value: PAD, amount: 500000n };
    const utxo = { transactionId: ZERO_COVID, index: 0, realKas: 0n, state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 500000n } };
    const a = [kaspa, curveTplRB, tokenTpl, utxo, inv, bytesOf(CURVE_COVID), bytesOf(BUYER), 1000000n, 99n, [], 2, { tokenDust: 50_000_000n }];
    const ref = M.buildCpBuy(...a), sdk = S.buildCpBuy(...a);
    cmp('curve buy (recipient-bound, PADDED inventory carrier)', ref, sdk);
    const okPad = sdk.outputs[1].value === PAD;
    console.log(`  ${okPad ? 'PASS' : 'FAIL'}  padded inventory continuation tracks the input (got ${sdk.outputs[1].value}, expected ${PAD})`);
    if (!okPad) fails++;

    const pUtxo = { transactionId: '79'.repeat(32), index: 0, state: swapState, tokenUtxo: { transactionId: '7a'.repeat(32), index: 0, value: PAD } };
    const q = MP.quotePoolCpSell(swapState, swapParams, 500000n);
    const traderTokens = [{ transactionId: '7b'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), 500000n) }];
    const pa = [kaspa, poolTplRB, tokenTpl, swapParams, pUtxo, poolCovid, bytesOf(BUYER), traderTokens, q, 3, { tokenDust: 50_000_000n }];
    const pRef = MP3.buildPoolV3SwapTokenForKas(...pa), pSdk = SP3.buildPoolV3SwapTokenForKas(...pa);
    cmp('swapTokenForKas (recipient-bound, PADDED pool-token carrier)', pRef, pSdk);
    const okPPad = pSdk.outputs[1].value === PAD;
    console.log(`  ${okPPad ? 'PASS' : 'FAIL'}  padded pool-token continuation tracks the input (got ${pSdk.outputs[1].value}, expected ${PAD})`);
    if (!okPPad) fails++;
    // This fixture is DELIBERATELY a full sell (500000 of 500000) — it is the RB full-sell branch's only
    // byte coverage (the main RB sell fixture is fractional), so pin the layout explicitly: no trader change,
    // the KAS leg is the LAST output. Do not "fix" it to fractional without adding a dedicated full-sell case.
    const okFull = !pSdk.outputs.some((o) => o.role === 'trader') && pSdk.outputs[pSdk.outputs.length - 1]?.role === 'traderKas';
    console.log(`  ${okFull ? 'PASS' : 'FAIL'}  full sell: no trader change, KAS leg is the last output`);
    if (!okFull) fails++;
  }
}

// --- DISCRIMINATOR HYDRATION end-to-end (backend echo → client.shapeCpTemplates → builders) ---------------
// shapeCpTemplates is the single point that decides which ABI the SDK emits, and the sections above construct
// their template flags BY HAND — so a drift in the backend echo's field names (or an inverted sniff) would
// silently hydrate recipientBound=false for every integrator, building legacy-ABI transactions every
// fix-schema covenant rejects, with every other gate green. Close that hole by running the REAL backend
// compiler (the same module `POST /api/native/cp-template` serves) through the SDK's shaping and asserting
// the flags — true on the current schema, false on a pre-round-2 archived pin — then feeding the shaped
// current-schema templates straight into the builders for byte-parity on production-shaped objects.
{
  console.log('\ndiscriminator hydration end-to-end (backend cp-template echo → client.shapeCpTemplates)');
  process.env.SILVERC = SILVERC;   // nativeTemplates.mjs reads it at import time
  const NT = await import(pathToFileURL(`${KRON}/backend/nativeTemplates.mjs`).href);
  const CL = SDK_MOD.client;
  const reqParams = {
    creatorFeeOwner: CREATOR, platformFeeOwner: PLATFORM,
    vKas, graduationKas, creatorFeeBps: cB, platformFeeBps: pB, graduationFeeBps: gB,
    dexCreatorFeeBps: DEX_C, dexPlatformFeeBps: DEX_P, dexLpFeeBps: LP_BPS, poolLockedShares: POOL_LOCKED,
    devFundOwner: DEV_FUND, devFundBps: devBps, tokenCovid: TOKEN_COVID,
  };

  const cur = NT.compileCpTemplates({ ...reqParams, templateVersion: null });
  const shaped = CL.shapeCpTemplates(cur);
  const okCur = shaped.curve.recipientBound === true && shaped.pool.recipientBound === true
    && shaped.pool.zeroRemoveAllowed === true && shaped.pool.canonicalInventoryRequired === true
    && shaped.curve.params.devFundBps === BigInt(devBps) && shaped.curve.params.vKas === BigInt(vKas);
  console.log(`  ${okCur ? 'PASS' : 'FAIL'}  current schema hydrates ALL fix-schema flags true (curve.rb=${shaped.curve.recipientBound} pool.rb=${shaped.pool.recipientBound} zeroRemove=${shaped.pool.zeroRemoveAllowed} canonical=${shaped.pool.canonicalInventoryRequired})`);
  if (!okCur) fails++;

  // Pre-round-2 archived pin (the KRN pre-audit-fix schema): recipient flags MUST come back false — the
  // fail-safe direction. An absence-blind mapping that defaulted a flag true would corrupt every old-pinned
  // token's arg stack.
  const ARCHIVED_PRE_L12 = 'a9b901ac9269099d9f1be60af7f7aae1eeb508cc0b80e190a782aa3440926921';
  const arch = NT.compileCpTemplates({ ...reqParams, templateVersion: { schema: ARCHIVED_PRE_L12 } });
  const shapedA = CL.shapeCpTemplates(arch);
  const okArch = shapedA.curve.recipientBound === false && shapedA.pool.recipientBound === false
    && shapedA.pool.zeroRemoveAllowed === false && shapedA.pool.canonicalInventoryRequired === true;
  console.log(`  ${okArch ? 'PASS' : 'FAIL'}  archived pre-round-2 pin (${ARCHIVED_PRE_L12.slice(0, 12)}…) hydrates recipient flags false (curve.rb=${shapedA.curve.recipientBound} pool.rb=${shapedA.pool.recipientBound} zeroRemove=${shapedA.pool.zeroRemoveAllowed})`);
  if (!okArch) fails++;

  // Builder byte-parity ON THE SHAPED OBJECTS — proves the shaped templates (production compile, echo-derived
  // params and flags, tokenCovid baked) drive both implementations to identical bytes, not just the
  // hand-flagged parity-ctor templates above.
  {
    const inv = { transactionId: '11'.repeat(32), index: 0, value: 1000n, amount: 500000n };
    const utxo = { transactionId: ZERO_COVID, index: 0, realKas: 0n, state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 500000n } };
    const a = [kaspa, shaped.curve, shaped.token, utxo, inv, bytesOf(CURVE_COVID), bytesOf(BUYER), 1000000n, 99n, [], 2, { tokenDust: 50_000_000n }];
    cmp('curve buy (echo-shaped current-schema template)', M.buildCpBuy(...a), S.buildCpBuy(...a));

    const swapState = { kasReserve: 78763432n, tokenReserve: 31891357n, totalShares: 1149416n, tokenCovid: bytesOf(TOKEN_COVID), lpCovid: bytesOf('dd'.repeat(32)) };
    const swapParams = { creatorFeeOwner: bytesOf(CREATOR), platformFeeOwner: bytesOf(PLATFORM), creatorFeeBps: 10n, platformFeeBps: 70n, lpFeeBps: 20n, lockedShares: 1000000n };
    const pUtxo = { transactionId: '79'.repeat(32), index: 0, state: swapState, tokenUtxo: { transactionId: '7a'.repeat(32), index: 0, value: 1000n } };
    const q = MP.quotePoolCpSell(swapState, swapParams, 500000n);
    const traderTokens = [{ transactionId: '7b'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(BUYER), 600000n) }];
    const pa = [kaspa, shaped.pool, shaped.token, swapParams, pUtxo, bytesOf('ee'.repeat(32)), bytesOf(BUYER), traderTokens, q, 3, { tokenDust: 50_000_000n }];
    cmp('swapTokenForKas (echo-shaped current-schema template)', MP3.buildPoolV3SwapTokenForKas(...pa), SP3.buildPoolV3SwapTokenForKas(...pa));
  }
}

console.log(`\n${fails === 0 ? '✓ PARITY OK — SDK builders are byte-identical to the covenant-verified reference' : '✗ ' + fails + ' PARITY MISMATCH(ES) — SDK has drifted from the covenant; do not publish'}`);
process.exit(fails === 0 ? 0 : 1);
