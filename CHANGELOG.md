# Changelog

All notable changes to this package are documented here. This project follows
[Semantic Versioning](https://semver.org).

## 0.6.1

### Added — covenant template-version pin surfaced in the types (KRON ROADMAP 3.5)

KRON now pins every token to the covenant source-set version it was deployed under, so future covenant
changes can't strand deployed tokens. The registry stamps `cp.templateVersion = { schema, silverc }`
server-side (`schema` = blake2b-256 of the `.sil` source set, archived at `covenants/versions/<schema12>/`
in the kron repo; `silverc` = the pinned compiler commit), and the public token list exposes it at
`extensions.templateVersion`.

- New `TemplateVersionRecord` type; `RegistryToken.cp.templateVersion` and
  `TokenListEntry.extensions.templateVersion` are now typed (both nullable — `null` marks a pre-pinning
  legacy record).
- `RegistryToken` also gained the rest of the live record's `cp` fields (`initialInventory`, `devAmount`,
  `vesting` via the new `CpVestingRecord`) plus top-level `creatorPubkey` / `graduated` / `createdAt`.
- Docs: an auditor re-deriving covenant templates/addresses from `curveParams` must compile the PINNED
  source set — not the newest sources. `verify.verifyTokenListEntry` itself is version-independent
  (it checks the consensus-assigned covenantId against the genesis tx) and is unchanged.

No runtime behavior changes — purely additive types + documentation.

## 0.6.0

### Fixed — trade/LP/vesting builders produced transactions the chain always rejects

0.5.0 fixed `assembleNativeTx` and the kcc20 builders (`buildKcc20Send`,
`buildSplitToken`, `buildConsolidate`) to attach the KIP-20 `CovenantBinding`
required on every covenant output — but the curve, pool/LP, and vesting
builders still returned outputs with `binding` unset. A consumer assembling
those spends with `assembleNativeTx` got the same on-chain rejection
(`script ran, but verification failed`) unless they patched
`spend.outputs[i].binding` in manually. All are now wired automatically,
mirroring exactly what the reference KRON web app's flows do (see
`web/src/tradeCpFlow.ts`, `swapPoolFlow.ts`, `lpFlow.ts`,
`claimVestingFlow.ts` in the kron monorepo).

- `curveCp.buildCpBuy` / `buildCpSell` — curve continuation bound to the
  curve covid `C` (authorized by input 0); inventory / recipient / seller-
  change outputs bound to the token covid `A` (authorized by input 1, the
  inventory input). Fee outputs are correctly left unbound (plain P2PK).
- `curveCp.buildCpGraduate` — locked curve bound to `C` (input 0); the new
  pool's genesis output bound to the freshly-derived pool covid `P`
  (authorized by input 0, the curve input — pool genesis has no input of
  its own yet); the pool-token output bound to `A` (authorized by input 1,
  the inventory input). The graduation-fee output stays unbound.
- `poolCpV3.buildPoolV3SwapKasForToken` / `buildPoolV3SwapTokenForKas` —
  pool continuation bound to the pool covid `P` (input 0); pool-token /
  trader / trader-change outputs bound to `A` (input 1, the pool-token
  input). Fee outputs stay unbound.
- `poolCp.buildAddLiquidity` — pool continuation bound to `P` (input 0);
  grown reserve bound to `A` (input 2, the pool-reserve input); reduced L
  inventory + the LP's new shares bound to the pool's LP covid `L` (input
  3, the L-inventory input).
- `poolCp.buildRemoveLiquidity` — pool continuation bound to `P` (input 0);
  shrunk reserve + the LP's withdrawn token bound to `A` (input 1, the
  pool-reserve input); shares returned to inventory bound to `L` (input 2,
  the LP-shares input).
- `poolCp.buildBindLp` — pool continuation bound to `P` (input 0); the
  locked floor + the pool's new L inventory bound to the freshly-derived L
  covid (also input 0 — bindLp has a single input).
- `vesting.buildVestingClaim` / `buildVestingClaimFinal` gain an
  `opts.tokenCovid` parameter (same optional pattern as
  `buildSplitToken`/`buildConsolidate`): the vesting-continuation output is
  always bound to `vestingCovid` (already a required param); the relock /
  recipient outputs are bound to `opts.tokenCovid` when passed, and left
  unbound (as before) when omitted.

None of this changes any signature script, redeem script, or output value —
bindings live entirely on `CovOutput`/transaction-output metadata, so
assembled transactions remain byte-identical to the covenant-verified
reference builders (`npm run verify:parity`, which does not compare
bindings, still passes).

### Migration

If you called any of the above builders directly and relied on setting
`spend.outputs[i].binding` yourself before calling `assembleNativeTx`, you
can drop that step — the builders now do it for you. `buildVestingClaim` /
`buildVestingClaimFinal` callers who want the relock/recipient outputs
bound should pass `opts.tokenCovid` (the vested token's `covenantId`, hex,
from your indexer).

## 0.5.0

### Fixed — `assembleNativeTx` produced transactions the chain always rejects

`assembleNativeTx` built **version-0** transactions with no `CovenantBinding`
on the covenant outputs. A v0 output cannot carry a covenant binding, so the
outputs never joined the covenant-id group, the covenant's
`OpCovOutputCount(id)` check saw zero outputs, and every assembled spend was
rejected on-chain with `script ran, but verification failed` (the signature
script itself was correct — the transaction body was the problem). All
`0.2.x`–`0.4.x` consumers of `assembleNativeTx` are affected; the builders'
signature scripts were and are correct.

- `assembleNativeTx` now builds KIP-20 **v1** transactions: covenant outputs
  carry `CovenantBinding(authorizingInput, covenantId)` (from the new
  `CovOutput.binding` field) and every input carries a v1 `computeBudget`
  (role-based defaults; override per input via `CovInput.computeBudget`).
- New `kron.spend.estimateNativeFee(k, networkId, asm, feeRateSompiPerGram)` —
  v1 fees must cover the per-input compute budget on top of byte/storage
  mass; a flat legacy fee is too low. Assemble with a placeholder fee, call
  this, re-assemble with the result.
- New constants: `TX_VERSION`, `FUNDING_COMPUTE`, `TOKEN_COMPUTE`,
  `COVENANT_COMPUTE`, `COVENANT_DUST`.

### Added — first-class KCC-20 "Send" path

- `kron.kcc20.buildKcc20Send(k, tpl, senderTokens, recipientPubkey32,
  sendAmount, presenceWitnessIdx, tokenCovid, opts?)` — the user→user wallet
  "Send": N presence-owned token UTXOs → `[recipient, change]`, outputs
  binding-complete (requires the token's `covenantId` from the indexer).
- `kron.kcc20.decodeKcc20Redeem(redeem, opts?)` — recover the splice template
  (`{script, stateStart}`) **and** the current balance state from a live
  UTXO's `redeemScriptHex`, replacing hand-rolled state decoding.
- `kron.curveCp.buildSplitToken` / `buildConsolidate` accept
  `opts.tokenCovid` and set the output bindings when given. Their
  `covids.tokenCovid` result field previously reported the **owner pubkey**
  (not the token covenant id!) — it is now the real covenant id when
  `opts.tokenCovid` is passed, and omitted otherwise. Never use the owner
  pubkey as a binding id.
- Runnable end-to-end example: `scripts/example-kcc20-send.mjs`
  (documented in `docs/INTEGRATION.md` §5).

### Migration

If you assembled transactions yourself (bypassing `assembleNativeTx`), build
them as v1: `new Transaction({ version: 1, ... })`, covenant outputs as
`new TransactionOutput(value, spk, new CovenantBinding(authorizingInput, new
Hash(covidHex)))`, and every input with a `computeBudget`. If you used
`assembleNativeTx`, upgrade and pass the covenant id to the kcc20 builders
(`buildKcc20Send` requires it; `buildSplitToken`/`buildConsolidate` via
`opts.tokenCovid`).

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
