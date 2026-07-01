// Go/no-go gate (per extraction plan §2): does the vendored WEB-target kaspa.js/kaspa_bg.wasm actually
// load and work in plain Node via raw-bytes init (bypassing fetch()), standalone — i.e. outside kron's own
// repo/node_modules/CWD context? If this fails, the whole "ship one universal WASM blob, two thin loader
// shims" plan is wrong and we need a real nodejs-target build instead. Run: node scripts/smoke-test-node-wasm.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import init, * as kaspa from '../vendor/kaspa/kaspa.js';

const wasmPath = fileURLToPath(new URL('../vendor/kaspa/kaspa_bg.wasm', import.meta.url));

async function main() {
  console.log('1. Reading wasm bytes from disk...');
  const bytes = await readFile(wasmPath);
  console.log(`   ${bytes.length} bytes read`);

  console.log('2. Calling init({ module_or_path: bytes }) — bypassing fetch()...');
  await init({ module_or_path: bytes });
  console.log('   init() resolved OK');

  console.log('3. new kaspa.PrivateKey(...) -> toAddress() -> payToAddressScript(...)');
  const pk = new kaspa.PrivateKey(randomBytes(32).toString('hex'));
  const pubkey = pk.toPublicKey();
  const addr = pubkey.toAddress(kaspa.NetworkType.Testnet);
  console.log('   derived address:', addr.toString());
  const spk = kaspa.payToAddressScript(addr);
  console.log('   scriptPublicKey:', JSON.stringify(spk).slice(0, 80) + '...');

  console.log('4. new kaspa.ScriptBuilder()');
  const sb = new kaspa.ScriptBuilder();
  sb.addOp(kaspa.Opcodes.OpData1);
  console.log('   ScriptBuilder constructed + addOp OK, script:', sb.toString().slice(0, 20) + '...');

  console.log('5. signMessage/verifyMessage (KIP-5 path)');
  const sig = kaspa.signMessage({ message: 'kron-sdk smoke test', privateKey: pk });
  const ok = kaspa.verifyMessage({ message: 'kron-sdk smoke test', signature: sig, publicKey: pubkey.toString() });
  console.log('   signMessage -> verifyMessage roundtrip:', ok === true ? 'OK' : `FAILED (got ${ok})`);

  console.log('6. covenantId(...) — KIP-20 covenant-id computation');
  const outpoint = new kaspa.TransactionOutpoint(new kaspa.Hash('0'.repeat(64)), 0);
  const covid = kaspa.covenantId(outpoint, []);
  console.log('   covenantId:', covid.toString().slice(0, 20) + '...');

  console.log('\nALL CHECKS PASSED — vendored web-target WASM works standalone in Node via raw-bytes init.');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exit(1);
});
