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
const missing = [SILVERC, KWASM_JS, REF_CURVE].filter((p) => !existsSync(p));
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
const { addressPresenceOwned, IDENTIFIER } = await import(pathToFileURL(REF_KCC20).href);
const SDK_MOD = await import(pathToFileURL(SDK_DIST).href);
const S = SDK_MOD.curveCp;                                             // this SDK's built builders
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
// Current curve_cp ABI. Tail order: vesting template (EMPTY/ZERO here = non-vested deploy), vestingTotal,
// poolLockedShares, initTokenReserve, batch-order template, then the dev-fund leg declared LAST.
const curveCtor = [arr(bytesOf(CREATOR)), arr(bytesOf(PLATFORM)), arr(bytesOf(CREATOR)), I(vKas), I(graduationKas), I(cB), I(pB), I(gB), arr(bytesOf(ZERO_COVID)), arr(tokPrefix), arr(tokSuffix), arr(tplHash), I(tokPrefix.length), I(tokSuffix.length), arr(pPre), arr(pSuf), arr(poolV2TplHash), Bo(false), arr(new Uint8Array(0)), arr(new Uint8Array(0)), arr(bytesOf(ZERO_COVID)), I(0), I(POOL_LOCKED), I(0), arr(orderTplHash), I(oPre.length), I(oSuf.length), arr(bytesOf(DEV_FUND)), I(devBps)];
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
  const a = [kaspa, curveTpl, tokenTpl, utxo, inv, bytesOf(CURVE_COVID), bytesOf(BUYER), 1000000n, 99n, [], 0, {}];
  cmp('buy (dev-fund ABI)', M.buildCpBuy(...a), S.buildCpBuy(...a));
  const aL = [kaspa, curveTplLegacy, tokenTpl, utxo, inv, bytesOf(CURVE_COVID), bytesOf(BUYER), 1000000n, 99n, [], 0, {}];
  cmp('buy (legacy two-fee ABI)', M.buildCpBuy(...aL), S.buildCpBuy(...aL));
}
{
  const inv = { transactionId: '22'.repeat(32), index: 0, value: 1000n, amount: 400000n };
  const utxo = { transactionId: ZERO_COVID, index: 0, realKas: 10000000n, state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 400000n } };
  const seller = { transactionId: '33'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(TRADER), 500n) };
  const a = [kaspa, curveTpl, tokenTpl, utxo, [seller], inv, bytesOf(CURVE_COVID), bytesOf(TRADER), 160n, 2000000n, 3, {}];
  cmp('sell (fractional, change — dev-fund ABI)', M.buildCpSell(...a), S.buildCpSell(...a));
  const s2 = { transactionId: '33'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(TRADER), 160n) };
  const a2 = [kaspa, curveTpl, tokenTpl, utxo, [s2], inv, bytesOf(CURVE_COVID), bytesOf(TRADER), 160n, 2000000n, 3, {}];
  cmp('sell (full-UTXO — dev-fund ABI)', M.buildCpSell(...a2), S.buildCpSell(...a2));
  // The dev-fund output sits at the FIXED index 4, so on a fractional sell the covid-A change shifts to [5].
  const aL = [kaspa, curveTplLegacy, tokenTpl, utxo, [seller], inv, bytesOf(CURVE_COVID), bytesOf(TRADER), 160n, 2000000n, 3, {}];
  cmp('sell (fractional, change — legacy two-fee ABI)', M.buildCpSell(...aL), S.buildCpSell(...aL));
}
{
  const inv = { transactionId: '11'.repeat(32), index: 0, value: 1000n, amount: 2500n };
  const utxo = { transactionId: ZERO_COVID, index: 0, realKas: BigInt(graduationKas), state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 2500n } };
  const a = [kaspa, curveTpl, tokenTpl, poolV2Tpl, utxo, inv, bytesOf(CURVE_COVID), BigInt(POOL_LOCKED), {}];
  cmp('graduate', M.buildCpGraduate(...a), S.buildCpGraduate(...a));
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

console.log(`\n${fails === 0 ? '✓ PARITY OK — SDK builders are byte-identical to the covenant-verified reference' : '✗ ' + fails + ' PARITY MISMATCH(ES) — SDK has drifted from the covenant; do not publish'}`);
process.exit(fails === 0 ? 0 : 1);
