# Changelog

All notable changes to this package are documented here. This project follows
[Semantic Versioning](https://semver.org).

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
