# Changelog

All notable changes to this package are documented here. This project follows
[Semantic Versioning](https://semver.org).

## 0.4.0

### Changed (BREAKING) — curve hardening

The `curve_cp` covenant was hardened: it now commits its **token reserve to
covenant state** rather than reading it from a transaction input (a security
fix — the reserve can no longer be spoofed by presenting a decoy inventory
input). This changes the curve's on-chain layout and address, so the curve
builders are updated to match. **Tokens deployed before this update
(old-template) are not built correctly by these builders — pin `0.3.x` if you
must interact with pre-hardening tokens.** Old-template tokens are being
removed from the KRON registry as part of this rollout.

- `curveCp.CpCurveState` gains a **required** `tokenReserve: bigint` field.
  Supply the curve's current committed reserve (chain-derived from your
  indexer) in `utxo.state`.
- `curveCp.materializeCpScript` / `cpAddress` now require the `tokenReserve`
  state field; the state region is 44 bytes (was 35).
- `curveCp.buildCpSell` **signature changed** — now takes `sellerTokens` (an
  array, enabling fractional sells that return the unsold remainder as change)
  and a `traderPubkey`:
  `buildCpSell(k, tpl, tokenTpl, utxo, sellerTokens, inventory, curveCovid,
  traderPubkey, tokenIn, kasOut, presenceWitnessIdx, opts?)`.
- `curveCp.buildCpBuy` gained `mergeTokens` + `presenceWitnessIdx` params
  (before `opts`) so a buy can merge the buyer's existing holdings into one
  output. Callers that passed `opts` positionally must move it to the new slot.

The updated curve builders are byte-identical to the reference implementation
verified against the on-chain (Kaspa txscript) VM.

## 0.3.0

### Added
- **Curve sequencing** — `client.SequencerClient.curveHead()` / `.curveSubmit()` wrap the sequencer's
  pre-graduation bonding-curve endpoints (`/curve/head`, `/curve/submit`), so integrators can chain
  launch-phase buys/sells on a hot token exactly like pool swaps (same non-custodial model: build + sign
  locally, the sequencer only orders and relays). `health()` now types the `markets` capability field.
  New types: `CurveSequencerHead`, `CurveHeadResult`.
- **Partner attribution** — optional `ref` on `submit()` and `curveSubmit()`: wallet-integrator partners
  (kron.technology/wallets) tag their trades with their partner tag (2–32 chars `a-z 0-9 - _`); tagged
  trades are recorded server-side per-trade as the revenue-share settlement record. Malformed tags are
  rejected with 400 (fail loudly on the first submit, not silently at settlement). `health()` types the
  `attribution` capability flag.

### Changed
- Docs: `INTEGRATION.md` §6 rewritten to cover both sequencer markets (the "pool-only" caveat is gone —
  the deployed sequencer reports `markets: ['pool','curve']`).

## 0.2.1

### Changed
- Docs only: corrected the version badge, added this changelog, and removed third-party project names from
  the indexer references. No code or API changes.

## 0.2.0

### Added
- **Token list** — `client.RegistryClient.tokenlist()` returns KRON's
  [tokenlists.org](https://tokenlists.org)-shaped token index: one URL for wallets, explorers, and price
  aggregators to discover every KRON token and how to identify it. Verified-only by default; pass
  `{ all: true }` to include unverified entries (each tagged `extensions.chainVerified: false`).
- **On-chain verifier** — `verify.verifyTokenListEntry` confirms a token-list entry against the chain
  (anti-spoof): it checks the entry's `covenantId` was genuinely created on its `genesisTxid`. Ships with
  `verify.kaspaRestFetchTx` for the common Kaspa REST shape, or inject your own node/RPC fetcher.

## 0.1.1

### Added
- Initial public release. Trade-only transaction builders against already-deployed KRON tokens
  (buy / sell / graduate, pool swap + add/remove liquidity, kcc20 transfer, vesting claim), typed
  indexer / registry / sequencer REST clients, and the `WalletAdapter` interface with a generic reference
  implementation. Does not include the covenant compiler or `.sil` sources — builders operate on
  already-compiled script bytes read from the indexer.
