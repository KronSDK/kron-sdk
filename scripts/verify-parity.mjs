// Parity guard — proves this SDK's curve builders produce BYTE-IDENTICAL transactions to the reference
// builders in the private kron monorepo (which are tested against the on-chain Kaspa txscript VM on testnet).
// This is the drift catcher: if a covenant change lands in kron without being mirrored here (or vice-versa),
// buy/sell/graduate stop matching and this FAILS — blocking a release that would build invalid transactions.
//
// It needs the kron reference repo + the silverc compiler checked out locally (they are NOT public), so in any
// environment without them (external contributors, cloud CI) it SKIPS with a clear notice and exits 0.
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
const REF_KCC20 = `${KRON}/web/src/native/kcc20Tx.ts`;
const SDK_DIST = `${SDK}/dist/index.js`;
const N = `${KRON}/covenants/native`;

const missing = [SILVERC, KWASM_JS, REF_CURVE, SDK_DIST].filter((p) => !existsSync(p));
if (missing.length) {
  console.log(`⚠  PARITY CHECK SKIPPED — reference toolchain not found (set KRON_REPO to the kron monorepo).`);
  console.log(`   missing: ${missing.map((p) => p.replace(SDK, '.')).join(', ')}`);
  process.exit(0);
}

// --- load the kaspa WASM + both builder implementations -----------------------------------------
const kaspaMod = await import(pathToFileURL(KWASM_JS).href);
const kaspa = kaspaMod; const init = kaspaMod.default;
await init({ module_or_path: readFileSync(KWASM_BG) });
const M = await import(pathToFileURL(REF_CURVE).href);                 // reference builders (kron monorepo)
const { addressPresenceOwned, IDENTIFIER } = await import(pathToFileURL(REF_KCC20).href);
const S = (await import(pathToFileURL(SDK_DIST).href)).curveCp;        // this SDK's built builders
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
const BUYER = '03'.repeat(32), TRADER = '04'.repeat(32);
const DEX_C = 20, DEX_P = 10, LP_BPS = 20, POOL_LOCKED = 1000;
const poolV2Ctor = [I(0), I(0), I(0), I(POOL_LOCKED), arr(bytesOf(TOKEN_COVID)), arr(tokPrefix), arr(tokSuffix), arr(tplHash), arr(bytesOf(ZERO_COVID)), arr(bytesOf(CREATOR)), arr(bytesOf(PLATFORM)), I(DEX_C), I(DEX_P), I(LP_BPS)];
const poolV2Gen = compile(`${N}/amm_pool_cp_v3.sil`, poolV2Ctor);
const poolV2Tpl = { script: Uint8Array.from(poolV2Gen.script), stateStart: poolV2Gen.state_layout.start };
const pPre = poolV2Tpl.script.slice(0, poolV2Tpl.stateStart), pSuf = poolV2Tpl.script.slice(poolV2Tpl.stateStart + poolV2Gen.state_layout.len);
const poolV2TplHash = blake2b256(Buffer.concat([Buffer.from(pPre), Buffer.from(pSuf)]));

const vKas = 5000, graduationKas = 5000000000, cB = 70, pB = 30, gB = 500;
const curveCtor = [arr(bytesOf(CREATOR)), arr(bytesOf(PLATFORM)), arr(bytesOf(CREATOR)), I(vKas), I(graduationKas), I(cB), I(pB), I(gB), arr(bytesOf(ZERO_COVID)), arr(tokPrefix), arr(tokSuffix), arr(tplHash), I(tokPrefix.length), I(tokSuffix.length), arr(pPre), arr(pSuf), arr(poolV2TplHash), Bo(false), arr(bytesOf(ZERO_COVID)), I(POOL_LOCKED), I(0)];
const curveGen = compile(`${N}/curve_cp.sil`, curveCtor);
const curveTpl = { script: Uint8Array.from(curveGen.script), stateStart: curveGen.state_layout.start, params: { creatorFeeOwner: bytesOf(CREATOR), platformFeeOwner: bytesOf(PLATFORM), vKas: BigInt(vKas), graduationKas: BigInt(graduationKas), creatorFeeBps: BigInt(cB), platformFeeBps: BigInt(pB), graduationFeeBps: BigInt(gB) } };

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
{
  const inv = { transactionId: '11'.repeat(32), index: 0, value: 1000n, amount: 500000n };
  const utxo = { transactionId: ZERO_COVID, index: 0, realKas: 0n, state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 500000n } };
  const a = [kaspa, curveTpl, tokenTpl, utxo, inv, bytesOf(CURVE_COVID), bytesOf(BUYER), 1000000n, 99n, [], 0, {}];
  cmp('buy', M.buildCpBuy(...a), S.buildCpBuy(...a));
}
{
  const inv = { transactionId: '22'.repeat(32), index: 0, value: 1000n, amount: 400000n };
  const utxo = { transactionId: ZERO_COVID, index: 0, realKas: 10000000n, state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 400000n } };
  const seller = { transactionId: '33'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(TRADER), 500n) };
  const a = [kaspa, curveTpl, tokenTpl, utxo, [seller], inv, bytesOf(CURVE_COVID), bytesOf(TRADER), 160n, 2000000n, 3, {}];
  cmp('sell (fractional, change)', M.buildCpSell(...a), S.buildCpSell(...a));
  const s2 = { transactionId: '33'.repeat(32), index: 0, value: 1000n, state: addressPresenceOwned(bytesOf(TRADER), 160n) };
  const a2 = [kaspa, curveTpl, tokenTpl, utxo, [s2], inv, bytesOf(CURVE_COVID), bytesOf(TRADER), 160n, 2000000n, 3, {}];
  cmp('sell (full-UTXO)', M.buildCpSell(...a2), S.buildCpSell(...a2));
}
{
  const inv = { transactionId: '11'.repeat(32), index: 0, value: 1000n, amount: 2500n };
  const utxo = { transactionId: ZERO_COVID, index: 0, realKas: BigInt(graduationKas), state: { graduated: false, tokenCovid: bytesOf(TOKEN_COVID), tokenReserve: 2500n } };
  const a = [kaspa, curveTpl, tokenTpl, poolV2Tpl, utxo, inv, bytesOf(CURVE_COVID), BigInt(POOL_LOCKED), {}];
  cmp('graduate', M.buildCpGraduate(...a), S.buildCpGraduate(...a));
}

console.log(`\n${fails === 0 ? '✓ PARITY OK — SDK builders are byte-identical to the covenant-verified reference' : '✗ ' + fails + ' PARITY MISMATCH(ES) — SDK has drifted from the covenant; do not publish'}`);
process.exit(fails === 0 ? 0 : 1);
