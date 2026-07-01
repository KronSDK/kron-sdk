// kron-sdk — build, sign, and submit transactions against ALREADY-DEPLOYED KRON covenant instances (trade,
// swap, transfer, LP, claim) from any JS/TS environment. This is the universal entrypoint: everything here
// is pure logic with zero environment coupling (Node vs browser only matters for *loading the Kaspa WASM
// SDK*, which lives behind `kron-sdk/wasm` — see wasm/index.node.ts / wasm/index.browser.ts, selected
// automatically via this package's `exports` map).
//
// This package deliberately does NOT include a covenant compiler or the .sil sources — it can't compile or
// deploy a new curve/pool/token instance. Builders here operate against a target's already-compiled script
// bytes (read from your indexer's live UTXO data, e.g. `redeemScriptHex`), not from source. See README.
//
// Namespaced (not flat) on purpose: builder names like `buy`/`sell`/`transfer` are generic enough to
// collide with consumer code at the top level.

export * as curve from './curve/cpCurve.js';

export * as sigscript from './native/sigscript.js';
export * as genesis from './native/genesis.js';
export * as spend from './native/spend.js';
export * as kcc20 from './native/kcc20Tx.js';
export * as curveCp from './native/curveCpTx.js';
export * as poolCp from './native/poolCpTx.js';
export * as poolCpV3 from './native/poolCpV3Tx.js';
export * as vesting from './native/vestingTx.js';

export * as wallet from './wallet/index.js';
export * as client from './client/index.js';
export * as verify from './verify/index.js';
