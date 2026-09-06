// kron-sdk — build, sign, and submit transactions against ALREADY-DEPLOYED KRON covenant instances (trade,
// swap, transfer, LP, claim) from any JS/TS environment. This is the universal entrypoint: everything here
// is pure logic with zero environment coupling (Node vs browser only matters for *loading the Kaspa WASM
// SDK*, which lives behind `kron-sdk/wasm` — see wasm/index.node.ts / wasm/index.browser.ts, selected
// automatically via this package's `exports` map).
//
// This package deliberately does NOT include a covenant compiler or the .sil sources — it can't compile or
// deploy a new curve/pool/token instance. Builders here operate against a target's already-compiled templates,
// fetched from the KRON backend's `POST /api/native/cp-template` and shaped by `client.fetchCpTemplates()`.
// An indexer's raw `redeemScriptHex` still yields a kcc20 template (`kcc20.decodeKcc20Redeem`), but not a
// curve/pool/vesting one: those additionally need their params (fee owners, vKas, graduationKas, fee bps,
// dev-fund leg — plus `stateLen` for vesting), which a redeem script does not expose, and their ABI
// discriminators cannot be recovered from the compiled bytes. See README.
//
// Namespaced (not flat) on purpose: builder names like `buy`/`sell`/`transfer` are generic enough to
// collide with consumer code at the top level.

export * as curve from './curve/cpCurve.js';

export * as sigscript from './native/sigscript.js';
export * as genesis from './native/genesis.js';
export * as spend from './native/spend.js';
/** On-chain partner attribution tag (encode/parse + REF_RE). Pass `ref` to `spend.assembleNativeTx` to tag a
 *  trade; use `parsePartnerTag` to read a tag back off a transaction payload from chain. */
export * as partnerTag from './native/partnerTag.js';
/** Covenant UTXO SELECTION — read this before writing your own. A KCC-20 UTXO's native KAS value is not
 *  part of its identity and is not predictable: no covenant pins it, and a different implementation may
 *  simply use a different default (this SDK did, before 0.13.3). Select by lineage, read the value from
 *  the entry you spend, and size funding with `carrierShortfall`. See docs/INTEGRATING-KCC20-UTXOS.md. */
export * as covenantSelect from './native/covenantSelect.js';
export * as kcc20 from './native/kcc20Tx.js';
export * as curveCp from './native/curveCpTx.js';
export * as poolCp from './native/poolCpTx.js';
export * as poolCpV3 from './native/poolCpV3Tx.js';
export * as vesting from './native/vestingTx.js';

export * as wallet from './wallet/index.js';
export * as client from './client/index.js';
export * as verify from './verify/index.js';
