# Changelog

All notable changes to this package are documented here. This project follows
[Semantic Versioning](https://semver.org).

## 0.18.2

### Docs — no code changes

A full audit of the integration docs after 0.18.1, prompted by the realisation that stale guidance was a
contributing cause of the `pick at an invalid location` incident: several places still taught the very path
that produces an unhydrated template. No behaviour, API or transaction bytes change — `verify:parity` is
byte-identical. Republished so the corrected README and JSDoc reach npm consumers, not just GitHub.

- **Template acquisition.** Four places still said to build a template from a UTXO's `redeemScriptHex`.
  That is right for **kcc20** templates (`decodeKcc20Redeem`) and wrong for **curve / pool / vesting**,
  which additionally need the baked `params` — and whose ABI discriminators cannot be recovered from the
  compiled bytes at all. Corrected in README (twice, both shipped), `src/native/curveCpTx.ts` and
  `src/index.ts`, and in `docs/INTEGRATION.md`.
- **Two recipient-bound schemas, not one.** The docs described `bdbcfb2540d1…` as *the* recipient-bound
  schema. `4de67d8649eb…` is also recipient-bound — on the **curve only** (`tradeRecipientBound = 1`,
  `poolRecipientBound = 0`) — and it is the **older** of the two, so the ABI is not a function of schema
  age and the two flags resolve independently. `docs/BUILDING-TRADES.md` now attributes HLK-L04 to both and
  HLK-L12 (with the pinned KAS legs at outputs 4 and 2) to round 2 alone: appending the recipient pair to a
  pool builder on a round-1 pin is the same class of failure in the opposite direction.
- **Legacy pool arity was wrong in shipped JSDoc.** `PoolCpTemplate.recipientBound` said "legacy 4/6-arg
  ABI (archived schemas)". The legacy pool declares **4/3/6/6** args in declaration order
  (`swapKasForToken` / `swapTokenForKas` / `addLiquidity` / `removeLiquidity`), `bindLp` takes 1 under both
  ABIs, and those schemas are not archived — they are what the great majority of live tokens run, so an
  absent flag is the *correct* resolution for them.
- **The witness bound is documented.** `MAX_WITNESS_IDX` and the `[0, 127]` range (127, not 255, because
  `0x80..0xff` decode as negative script numbers) had zero prose mentions anywhere. Now in README and
  `docs/INTEGRATING-KCC20-UTXOS.md`.
- **`cp-template` is now CORS-open.** It was locked to `https://kron.technology`, which blocked browser
  pages and MV3 content scripts from resolving a token's covenant ABI at all — while never blocking curl,
  so the lock bought nothing and only forced integrators to stand up a proxy. As of 2026-09-06 it answers
  `*` on every response, errors included, and stays compile-rate-limited per IP. `fetchCpTemplates` still
  takes `fetchImpl` / `baseUrl` if you would rather route through your own backend. The CORS table in
  `docs/INTEGRATION.md` also described the old lock by the wrong criterion, and is corrected.
- Warning cadence corrected to **once per builder** (up to six lines), not once per process;
  `KRON_SDK_SILENCE_ABI_WARNINGS`, the `shapeCpTemplates` throw, and the explicit `recipientBound: false`
  convention are all documented; `scripts/e2e-offline-flow.mjs` now sets that flag explicitly, so the one
  runnable sample no longer models a flagless template.

## 0.18.1

### Fixed — an unhydrated template no longer builds the wrong ABI in silence

0.18.0 shipped the recipient-bound ABI but left the discriminator optional and the fetch-and-map step to the
consumer. A template that never got `recipientBound` type-checked cleanly, built the **legacy** signature
script, and was rejected by the node at submit with:

```
failed to verify the signature script: encountered invalid state while running script:
pick at an invalid location
```

That error is a stack-arity failure, not a signing problem. silverc bakes each entrypoint argument's stack
depth into the compiled covenant as a constant and reads it with `OP_PICK`; a recipient-bound schema takes
two appended args (`witness`, `identifier`), so a legacy-arity sigscript leaves every one of those picks
pointing past the bottom of the stack. Measured on mainnet: a legacy curve buy carries 10 flattened args
(12 stack items with selector + redeem), a recipient-bound buy carries 12 (14 items). It hit buys and sells
equally, on exactly the recipient-bound schemas (`4de67d8649eb…` and `bdbcfb2540d1…`) and nothing else —
tokens on legacy schemas were always correct, because for those an absent flag *is* the right answer.

- **Added `client.fetchCpTemplates()`** — POSTs to `/api/native/cp-template` and returns already-shaped
  templates, so the un-hydrated path stops existing. `templateVersion` is a **required** option (pass `null`
  for a pre-pinning record): omitting it from the compile request silently resolves the *current* covenant
  sources instead of the token's pinned ones. `shapeCpTemplates` remains exported for bring-your-own-fetch.
- **`shapeCpTemplates` now throws** when the response echoes *no* ABI discriminators at all
  (`tradeRecipientBound`, `poolRecipientBound`, `zeroRemoveAllowed`, `canonicalLpInventory`). A current
  backend emits all four as `0`/`1` for every schema — including `0` on legacy pins — so total absence means
  a pre-HLK deployment that cannot say which ABI a token wants. Shaping it would reproduce exactly this bug.
- **Builders warn once when `recipientBound` is unset.** `buildCpBuy`, `buildCpSell`,
  `buildPoolV3SwapKasForToken`, `buildPoolV3SwapTokenForKas`, `buildAddLiquidity` and `buildRemoveLiquidity`
  emit a single `console.warn` per builder per process naming the node error and the fix. An **explicit
  `false`** is silent — that is a caller correctly asserting a legacy schema. Silence all with
  `globalThis.KRON_SDK_SILENCE_ABI_WARNINGS = true`.
- **Docs/types.** `CpTemplate.recipientBound`'s guidance was a `//` comment, so tsup stripped it from
  `dist/index.d.ts` and integrators saw a bare `recipientBound?: boolean` with no hover text. It is JSDoc now.

### Fixed — out-of-range witness indices were silently truncated

`transferSigScript` encoded `byte[] witnesses` with `w & 0xff`, so an out-of-range `presenceWitnessIdx`
became a *different* index rather than an error — `256` silently became `0`, which points at a covenant
input that carries no signature. Worse, anything ≥ 128 decodes on-chain as a **negative** script number
(`kcc20.sil`, HLK-L11: "the `>= 0` half is load-bearing"), so the usable ceiling is **127, not 255**. On
schemas carrying the HLK-L11 bounds check that surfaces as `script ran, but verification failed`; on every
pre-round-2 kcc20 (`4de67d8649eb…` and older) `tx.inputs[witnesses[i]]` is unguarded and it produces
`pick at an invalid location` — the same node string as an ABI-arity mismatch, from an unrelated cause.

Witness indices are now validated before anything is built: each must be an integer in `[0, 127]`, and the
error names the offending position and points at `presenceWitnessIdx`. Exported as `MAX_WITNESS_IDX`. No
in-range behaviour changes — `verify:parity` is byte-identical.

Behaviour for correctly-hydrated templates is unchanged — no assembled transaction bytes differ. There are
two breaking-ish edges, both of them cases 0.18.0 accepted and this release refuses: `shapeCpTemplates`
against a pre-HLK backend now throws instead of returning legacy templates, and a witness index outside
`[0, 127]` now throws instead of being truncated with `& 0xff` into a *different*, in-range index.

> **Upgrading from 0.17.x?** A version bump alone was never sufficient: `recipientBound` did not exist before
> 0.18.0, so any template-construction code carried across the bump is necessarily flagless. Route templates
> through `client.fetchCpTemplates()` (or `client.shapeCpTemplates()`).

A future **0.19.0** will make the discriminator a required field so a flagless template is a *compile* error.

## 0.18.0

### Added — recipient-bound covenant ABI (HLK-L04 / HLK-L07 / HLK-L12): trade recipient-bound tokens

The builders now speak the current KRON covenant schema's (`bdbcfb2540d1…`, Hashlock round-2 fix set)
recipient-bound ABI. Previously an SDK-built trade against a new-schema token was rejected by the covenant
(it bounced — funds never moved wrong); tokens pinned to older schemas were, and remain, unaffected. All of
it is gated on per-template discriminators — **absent flags mean the legacy ABI**, so existing integrations
against live tokens build byte-identical transactions to 0.17.x.

> **Correction (2026-09-06).** "Tokens pinned to older schemas were, and remain, unaffected" is false as
> written, and the byte-identical claim after it is narrower than it reads. There are **two** recipient-bound
> schemas, not one: `4de67d8649eb…` (Hashlock round 1, created 2026-08-26) is recipient-bound on the **curve
> only** (`tradeRecipientBound=1`, `poolRecipientBound=0`), and `bdbcfb2540d1…` (round 2, created 2026-08-28)
> is recipient-bound on **both** curve and pool. The two schemas' `curve_cp.sil` files are byte-identical, so
> curve buy/sell against `4de67d8649eb…` take the recipient-bound arity exactly as they do on `bdbcfb2540d1…`
> — being the older pin does not make it legacy, and the two flags resolve independently per template. The
> byte-identical-to-0.17.x guarantee therefore covers the tokens actually on legacy schemas — 84 of 86 live
> tokens as of 2026-09-06 — not everything that is not `bdbcfb2540d1…`.

- **Curve buy/sell (HLK-L04).** `CpTemplate` gained `recipientBound`. When set, `buildCpBuy`/`buildCpSell`
  append the (recipientWitness, recipientIdentifier) pair to the curve sigscript, and require
  `presenceWitnessIdx` to point past the covenant inputs at the buyer's/seller's own signed P2PK funding
  input (throwing at build time otherwise — the covenant's presence proof can never accept a covenant
  input).
- **Pool swaps + LP ops (HLK-L12).** `PoolCpTemplate` gained `recipientBound`. All four pool entrypoints
  append the same recipient pair; the two KAS-releasing legs additionally pin the proceeds as an explicit
  P2PK output: `buildPoolV3SwapTokenForKas` emits the trader's `kasOut − rawCreatorFee − rawPlatformFee` at
  output 4 (`role: 'traderKas'`; the optional trader change shifts to 5), and `buildRemoveLiquidity` emits
  the LP's `dKas·SCALE` at output 2, right after the reserve (`role: 'lpKas'`; dKas > 0 only). The same
  witness-index build guards apply (≥ 4 on add/removeLiquidity).
- **Zero-payout LP redemption (HLK-L07).** `PoolCpTemplate` gained `zeroRemoveAllowed`;
  `quoteRemoveLiquidity` and `snapRemoveDShares` accept `{ allowZeroPayout }` (pass the flag through) so a
  both-sides-zero redemption — legal on fix-schema pools, shares burn to the L inventory — quotes instead
  of throwing. Legacy callers are unchanged.
- **`client.shapeCpTemplates`** — the one mapping from the `POST /api/native/cp-template` response's params
  echo onto the template objects, discriminators included (`tradeRecipientBound` → curve,
  `poolRecipientBound` → pool, `zeroRemoveAllowed`, `canonicalLpInventory`). Use it instead of hand-shaping
  the response; a missed flag builds transactions every recipient-bound token rejects. See the new
  *Recipient-bound schemas* section in `docs/BUILDING-TRADES.md`.

### Changed

- `buildCpSell` now rejects a full drain (`kasOut == realKas`) on **every** schema (HLK-L05): the resulting
  zero-value curve output is rejected by Kaspa consensus (TxOutZero) regardless, so the SDK fails at build
  time with a clear message instead.
- `buildAddLiquidity` validates `lpInventory.amount == MAX_SHARES − totalShares` on
  `canonicalInventoryRequired` templates (mirroring `buildRemoveLiquidity`'s existing check) and derives the
  reduced inventory from `MAX_SHARES − newShares` — identical bytes for every honest call, but a stale
  inventory UTXO now fails at build time instead of on-chain.

### Verification

`verify:parity` gained a recipient-bound section: byte-parity for all six recipient-bound builders against
the kron reference (fractional, full-UTXO, dual-sided, both single-sided removes, and the zero-payout
burn), both-sides-throw checks for recipient-redirect attempts (a witness pointing at a covenant input),
reference-independent invariants for the two pinned KAS legs, and **padded-carrier fixtures** — every
pre-existing fixture fed a carrier worth ≤ dust, where `continuationValue(dust, input) === dust`, so a
builder regressed to emitting the bare constant stayed byte-identical and passed; the new fixtures feed a
padded carrier and pin the continuation to the input. It also runs the **discriminator hydration end to
end**: the real backend template compiler's echo through `client.shapeCpTemplates`, asserting all flags
true on the current schema and false on an archived pre-recipient-bound pin (`a9b901ac9269…`), then byte-parity of builds on the
echo-shaped templates — so a backend field rename can no longer silently revert every integrator to the
legacy ABI. New unit tests (no private toolchain needed) cover the build guards, the HLK-L07 quote
contract, and the `shapeCpTemplates` flag mapping.

### Docs

- README: new version-floor entry (≤ 0.17.2 speaks only the legacy ABI — recipient-bound trades bounce), a
  fourth integrator rule (hydrate ABI flags with `client.shapeCpTemplates`), and Quickstart template
  guidance now routes through `cp-template` + `shapeCpTemplates` instead of raw `redeemScriptHex` reads.
- `docs/BUILDING-TRADES.md`: new *Recipient-bound schemas* section; the `cp-template` response shape
  corrected (`{ token, pool, curve, params }` with a single top-level params echo) and pointed at the
  shaping helper.
- `docs/INTEGRATION.md`: corrected the per-input compute budgets — the doc still said the pre-right-sizing
  ≈ 500 (token) / ≈ 2000 (covenant); the actual constants are `TOKEN_COMPUTE = 100` /
  `COVENANT_COMPUTE = 400` (`FUNDING_COMPUTE = 10`), as `verify:parity` enforces. Trade recipes now
  reference the template-shaping step.

## 0.17.2

### Added — `WalletAdapter.signingGate` (optional)
A human-readable reason an adapter can set when it *has* a `signPskt` implementation but deliberately
disables it (e.g. pending the WALLETS.md §3 covenant-signing acceptance test on a mainnet build). dApps
surface it verbatim in their trade gates, distinguishing "gated, here's why" from "wallet genuinely lacks
the capability". Type-only, additive — no behavior change for existing adapters.

### Docs
- README no longer claims "there is no KRON testnet": the permanent TN10 staging environment
  (krontest.xyz) runs a testnet build, so the §3 acceptance test and write-path validation are free with
  faucet TKAS (mainnet remains an option). Same correction in `docs/WALLETS.md`.
- `docs/INTEGRATION.md`: new *Browser access (CORS) & rate limits* section (what browser contexts can call
  directly and the per-IP ceilings), and the previously undocumented
  `GET /api/registry/token/{covenantId}/descriptor` endpoint with its cache/rate-limit contract.

## 0.17.1

### Fixed — `SequencerClient` pool endpoints are keyed by TICK, not pool P2SH
`head()`, `events()`, and the docs said `poolP2sh`; the deployed sequencer has always keyed pools by the
token tick (the pool's P2SH moves with its state, so it was never a usable key — a P2SH got an
unknown-pool gate). Parameters renamed to `tick`; passing a tick was already correct at runtime, so this
is a docs/signature fix, not a behavior change.

### Added — `SequencerClient.status(tick, txid)`
The sequencer's view of a submitted tx: `broadcasting`, `accepted`, `rejected`, `broadcast-ambiguous`,
`confirmed`, `dropped`, or `unknown`. Check it after a submit timeout **before** re-submitting a rebuilt
tx directly — `broadcast-ambiguous` means the original may already be in the mempool, and a rebuilt tx
(new txid) would double-spend your own funding inputs.

### Docs — attribution wording
`submit()`'s `ref` doc no longer claims "only sequencer-routed trades carry attribution"; the canonical
path is the on-chain payload tag (`encodePartnerTag`), credited whether you submit through the sequencer
or straight to a node. `INTEGRATION.md` §6 documents `/status` and the tick keying.

### Docs — known wallet limitation: browser signing and `payload`
Kaspa commits `tx.payload` to the signature hash. A wallet whose `signPskt` computes that hash without
covering `payload` returns a signature that the node rejects with "script ran, but verification failed" —
but *only* on tagged trades, so it reads as a partner-attribution bug rather than a signing one. Documented
in `INTEGRATION.md` § Partner attribution, with the check that distinguishes a payload-blind wallet from a
tag applied after signing, and flagged inline on the README beside the `ref` example. Reported by kascov,
2026-08-10.

## 0.17.0

### Breaking — `buildAddLiquidity` now fails closed on the counterfeit-LP gate
`opts.lpBindVerified` is **required**. Previously the tripwire read `'lpBindVerified' in opts`, so omitting
the key skipped the check entirely and built an unguarded transaction. The README and `INTEGRATION.md` both
described the pre-check as mandatory; the code did not enforce it, so any integrator who had not read the
docs got no protection at all.

Only three pool schemas carry `require(OpCovInputCount(boundLp) == 0)`, the on-chain guard that makes a
counterfeit `bindLp` impossible. Ten do not, and template pinning is permanent — on those pools an honest
bind is an observed fact about one transaction, not a property the covenant enforces. A permissionless binder
can pass off a pre-minted token as the pool's LP shares and keep the remainder as counterfeit shares that
drain exactly the voluntary liquidity a depositor adds. A gate whose failure mode is a drained deposit must
not default to silence.

**Migration** — fetch the verdict and hand it to the builder:

```ts
await indexer.assertLpBindSafe(tick);                 // throws on false/unverifiable
const v = await indexer.lpBindVerified(tick);         // true | false | null
kron.poolCp.buildAddLiquidity(/* … */, { lpBindVerified: v });
```

Passing `false` or `null` throws, as before. Omitting the option (or `opts` entirely) now throws
`LP-bind integrity is UNVERIFIED` instead of building. If you established integrity by some other route,
pass `true` deliberately.

`buildRemoveLiquidity` is unchanged and remains ungated — an LP must always be able to exit.

## 0.16.0

### Required — builders emit `continuationValue` on covenant-owned continuations
KRON's covenants gained a **value-continuation** schema: `curve_cp` (buy / sell / graduate) and
`amm_pool_cp_v3` (both swaps, add/removeLiquidity, plus the L inventory) now enforce
`out.value >= in.value` on the covenant-owned token output. The check is RELATIVE, never an absolute dust
constant — baking a constant into an immutable redeem would brick every already-launched token if the dust
size ever changed. Shaving that output is now impossible; **padding it is still legal**.

That second half is why this is a required SDK change rather than a nicety. Emitting a bare `COVENANT_DUST`
against a PADDED reserve is rejected by consensus, and because that output is the token's only reserve, a
rejection wedges the token permanently. All nine continuation sites now emit
`continuationValue(dust, inputValue)` = max(dust, input). Apply it unconditionally — it is safe on older
schemas too, which constrain no output value.

`batchBuy`-style outputs are deliberately NOT converted: `curve_cp.sil` pins those `== ORDER_TOKEN_DUST`.

New export `covenantSelect.continuationValue`. Docs updated:
[docs/INTEGRATING-KCC20-UTXOS.md](docs/INTEGRATING-KCC20-UTXOS.md).

**New test file `src/native/covenantSelect.test.ts` (17 tests), and it covers a gap `verify:parity` cannot.**
Parity compares these builders byte-for-byte against the kron reference, but its fixtures only feed a
covenant-owned input holding exactly `COVENANT_DUST` — where `continuationValue(dust, input) === dust`. A
builder that regressed to the bare constant would stay byte-identical and parity would still pass. These tests
drive the unequal cases; reverting one emit site was verified to fail them (exit 1).

## 0.15.0

### Added — `covenantSelect` (covenant UTXO selection contract)
New namespace `covenantSelect` exporting `selectCovenantTokenUtxo`, `selectCovenantTokenOutpoint`,
`selectCovenantUtxo`, `selectCovenantOutpoint`, `carrierShortfall`, `carrierOf`, `normalizedCovenantId`
and `COVENANT_DUST`.

**Why it matters for integrators.** A KCC-20 UTXO's native KAS value is not part of its identity and is not
predictable. `kcc20.sil` conserves token amounts and constrains no output value; the curve/pool covenants pin
only their own KAS continuation and fee legs, so on buy/sell/graduate/swap the covenant-owned token output's
value is whatever the transaction builder chose — VM-proven in the KRON repo's
`poc-token-output-value-unpinned.mjs`. Selecting a balance by `value === COVENANT_DUST`, or assuming that
figure for an input, therefore fails against a UTXO shaped by anyone else. That needs no attacker: **this SDK
itself defaulted an unset `tokenDust` to `1000n` before KRN-SDK-DUST in 0.13.3**, so divergent carrier values
have already occurred once in this ecosystem.

Select by lineage, take the value off the entry you spend, emit at `COVENANT_DUST`, and add
`carrierShortfall(inputValue)` to your funding selection. Full rationale and a checklist:
[docs/INTEGRATING-KCC20-UTXOS.md](docs/INTEGRATING-KCC20-UTXOS.md).

Additive only — no existing export changed behaviour.

## 0.14.3

### Docs — README overhaul (no code change)

- Removed the stale "Upgrade to 0.11.0 for mainnet" callout — 0.11.0 was **not** sufficient (pool swaps
  were chain-rejected through 0.13.0, LP removal through 0.13.1). Guidance is now simply: install
  `@latest`, with a compact list of version floors and why each matters.
- Replaced the run-on per-version narrative in the header with a "two gates every integrator must
  implement" summary (`assertLpBindSafe` before add-liquidity; `sequencer.curveHead()` for the live
  curve UTXO). Full history remains here in the CHANGELOG.
- KIP-12 links now point to the active proposal (kaspanet/kips#44) instead of the superseded draft
  (#21), in README and `docs/WALLETS.md`.

## 0.14.2

### Docs — how to fetch the live curve UTXO before building a buy/sell

No code change. Clarifies a gap that was causing intermittent `no curve UTXO found (state moved?)`
failures for integrators building curve trades directly against the indexer: the curve covenant's
on-chain address is state-dependent (`tokenReserve` is spliced into its redeem script), so it moves
to a new address every trade. Deriving that address yourself from `indexer.token(tick).cpState` and
searching for its UTXO races the indexer's poll lag and fails on busy curves.

- README quickstart now says explicitly: use `sequencer.curveHead(curveCovid)` to get the live
  spendable outpoint, not a self-derived address lookup.
- `docs/INTEGRATION.md` gained a "Curve state (pre-graduation trades)" section (§4) and an updated
  "TG bot — buy on the curve" recipe (§8) pointing at the sequencer, with the indexer-only fallback
  retry cadence (5 attempts, 1.5s apart) if the sequencer is unreachable.

## 0.14.1

### Fixed — `quoteCpSell` / `quotePoolCpSell` could return a NEGATIVE `net` (the seller pays to sell)

**Upgrade if you quote or build sells.** Every fee output is padded to `FEE_OUT_MIN` (0.2 KAS) because a
sub-dust output blows the KIP-9 storage-mass cap. That makes the fee a *fixed floor* on small trades — 0.6 KAS
on the curve (creator + platform + dev-fund) and 0.4 KAS on a graduated pool (creator + platform). Both sell
quotes subtracted that floor from the gross and returned the result unguarded, so below the floor `net` went
negative: the seller handed over tokens **and** paid KAS for the privilege. The only pre-existing smallness
guard bounded the *gross* payout (`kasOutUnits <= 0n`), never the net.

- `curve.quoteCpSell` and `poolCp.quotePoolCpSell` now return `null` when `net <= 0`, instead of a quote whose
  `net` is negative or zero.
- **No API change and no code change required.** `null` is the same "not sellable" contract both functions
  already used for an amount below one SCALE step, and both return types were already `… | null`. If you
  render `.net`, or pass a quote to `buildCpSell`, upgrading is sufficient. Treat `null` as *"amount too small
  to sell"* rather than an error.
- **Not over-blocking.** `net` is strictly increasing in the gross payout (slope `1 − totalBps/10000`, and
  `padFee` is non-decreasing), so there is exactly one sign crossing: the guard rejects precisely the band
  where the seller loses money and nothing above it. On a live mainnet curve the boundary is exact — the
  smallest net-positive sell quotes normally, and one token less is refused.
- `curve.minOutWithSlippage` already clamped its tolerance to `[0, 10000]` bps; KRON's copy did not, and the
  two are now byte-identical again. An unclamped tolerance above 100% returns a *negative* min-out, which
  silently disables the slippage floor a caller passes to the trade flows.

Rough sizes, if you surface a minimum to users: the threshold is ~0.61 KAS of proceeds on a curve and ~0.41 KAS
on a pool, but in **token** terms it depends entirely on unit price — across live mainnet markets it ranges
from 1 token to ~16,000. Compute it per token rather than hard-coding a constant.

No assembled transaction bytes change for any sell that was worth building, so the release parity gate stays
byte-identical.

## 0.14.0

### Added — counterfeit-LP defence for pre-`e5469a7ad482` pools (gate `buildAddLiquidity`)

**If your integration adds liquidity to KRON pools, this release is required.** Tokens that graduated before the
pool covenant's counterfeit-LP guard landed (`e5469a7ad482`, i.e. anything pinned to `3297abfdaf8e` or earlier —
including `ansem`/`kron` and the tokens still on the bonding curve) run a `bindLp` that lacks
`require(OpCovInputCount(boundLp)==0)`. A permissionless binder can pass off a pre-minted token as the pool's LP
shares (a *continuation* L, not a genesis) and keep the remainder as counterfeit shares that redeem — via
`removeLiquidity` — for real KAS + tokens, draining exactly the voluntary liquidity a depositor adds. The covenant
is permanently pinned and cannot be patched for those tokens; the defence is off-chain and now spans the SDK.

- `IndexerClient` `CpState` gained `lpBindVerified?: boolean | null` (+ `lpSupply?`). The indexer reports the pool
  honest iff its L-share supply equals the invariant `MAX_SHARES − lockedShares`; a profitable counterfeit must
  retain shares beyond that, so it always exceeds it. `true` = safe, `false` = counterfeit, `null`/absent =
  not-yet-verifiable (treat as unsafe).
- `IndexerClient.lpBindVerified(tick)` and `IndexerClient.assertLpBindSafe(tick)` — **call `assertLpBindSafe`
  before `poolCp.buildAddLiquidity`.** It throws on `false` and, fail-safe, on `null`. Removing liquidity is never
  gated (honest LPs must always be able to exit).
- `poolCp.buildAddLiquidity` gained `opts.lpBindVerified` — a tripwire: if you pass the fetched flag and it is not
  `true`, the builder throws. Omitting it stays permitted for back-compat, but the pre-check is required.

Non-breaking (builders' assembled bytes are unchanged — parity gate byte-identical). `buildBindLp` is unaffected:
it only ever builds an honest genesis bind; the attack is crafted without the SDK, so this closes the *victim* side
(SDK-based liquidity providers), not an SDK-enabled exploit.

## 0.13.4

### Fixed — curve `buildCpBuy`/`buildCpSell`/`buildCpGraduate` had the same sub-dust `tokenDust` default as 0.13.3's pool builders

**If you call `buildCpBuy`, `buildCpSell`, or `buildCpGraduate` without an explicit `opts.tokenDust`, this
release is required.** 0.13.3 fixed this default on the pool builders only; the curve (bonding-curve) builders
carried the identical bare-`1000n` default and were missed. Same failure mode: covenant-valid but absurdly
expensive to relay. Reported and confirmed by a community integrator testing 0.13.3 against real curve buys.

All curve builders now default unset `tokenDust` to `COVENANT_DUST` (50,000,000 sompi), matching every other
builder in the package. **Upgrading is the whole fix.**

## 0.13.3

### Fixed — pool add/remove/swap builders defaulted unset `tokenDust` to sub-dust 1000 sompi

**If you call `buildAddLiquidity`, `buildRemoveLiquidity`, `buildBindLp`, `buildPoolV3SwapKasForToken`, or
`buildPoolV3SwapTokenForKas` without an explicit `opts.tokenDust`, this release is required.**

These builders defaulted the covenant-owned output's KAS value to a bare `1000n` sompi when `tokenDust` was
left unset — well below the KIP-9 storage-mass-safe floor (`COVENANT_DUST` = 50,000,000 sompi / 0.5 KAS). The
covenant does not constrain these outputs' KAS *value* at all (only their script/state), so a sub-dust build
is covenant-**valid** — it silently produces a transaction that is absurdly expensive to relay, discovered only
via `estimateNativeFee` returning a wildly inflated fee. Bumping the output's value after the fact to work
around it invalidates the funding inputs' signatures (the sighash commits to every output value), surfacing as
an unrelated "signature invalid: malformed signature" error instead of the actual cause.

All five builders now default unset `tokenDust` to `COVENANT_DUST` (exported from `./spend.js`) — the same
value `kcc20Tx.ts`'s `sendTokens` already used. If you already pass an explicit `tokenDust`, nothing changes.

**Upgrading is the whole fix.**

## 0.13.2

### Fixed — removeLiquidity was rejected on every current pool; unnecessary rejections on legitimate withdrawals

**If you build LP withdrawals (`buildRemoveLiquidity`), this release is required.**

`buildRemoveLiquidity` always built the pre-restructure ARCHIVED transaction shape — no pool-inventory input,
and the returned L amount set to the raw `dShares` — regardless of which covenant schema the pool actually
runs. Every pool live as of this SDK's release requires the CURRENT shape instead: the pool's *complete* L
inventory moves alongside the holder's shares, and the sole L output is the *consolidated* new inventory
(`MAX_SHARES − newShares`), not merely the redeemed amount. Every `removeLiquidity` this SDK built was
rejected by the covenant.

Two smaller issues shipped alongside it, both making legitimate withdrawals harder than the covenant requires:

- `quoteRemoveLiquidity` refused a withdrawal unless **both** the KAS and token side rounded to at least 1 —
  the covenant only requires **one** side to (`dKas > 0 || dToken > 0`), with the zero side simply carrying no
  recipient output. A small LP position on an asymmetric pool could be told "too small" when the covenant
  would have accepted it.
- `removeMinDShares` used the same too-strict rule (the **larger** of the two per-side thresholds instead of
  the **smaller**), which could report a withdrawal minimum well above what the covenant actually requires.

**Upgrading is the whole fix**, with one addition: `buildRemoveLiquidity` now takes an optional
`opts.lpInventory` — the pool's L-inventory UTXO, fetched the same way `buildAddLiquidity` already requires it
— which every current-schema pool needs. `PoolCpTemplate` gained an optional `canonicalInventoryRequired`
flag (present on the compiled template's params as `canonicalLpInventory` from the KRON registry) so the
builder knows which shape to build; every live pool sets it.

```ts
const spend = kron.poolCp.buildRemoveLiquidity(
  k, poolTpl, tokenTpl, utxo, lpShares, poolCovid, lpPubkey, quote, presenceWitnessIdx,
  { lpInventory },   // NEW — required whenever poolTpl.canonicalInventoryRequired is true
);
```

Verified against KRON's own covenant-verified reference implementation, byte-for-byte, across a dual-sided
withdrawal, a single-sided withdrawal (token side floors to zero), and the resulting transaction shape in
each case — including that the LP-token output is correctly omitted when its side rounds to zero.

## 0.13.1

### Fixed — pool swaps were rejected on-chain

**If you trade graduated tokens (AMM pool swaps), this release is required.** `buildPoolV3SwapKasForToken`
and `buildPoolV3SwapTokenForKas` produced transactions the node rejected with:

```
failed to verify the signature script: script ran, but verification failed
```

The builders were never the problem — the **quote** was. `retainKasUnits` (the voluntary-LP yield kept
in-pool on each trade) computed two nested integer *floors*, while the covenant computes an anti-partition
*ceiling*. The covenant changed to the ceiling on 2026-07-14 and this copy did not follow.

A retention one unit too small makes `quotePoolCpBuy` derive a `newToken` one unit too small — i.e. it offers
the buyer one retain-unit too many tokens. The covenant recomputes the real retention and rejects on its
constant-product check, `require((newKas - retainKas) * newToken >= oldK)`.

**Rejection was state-dependent, not random**, which made it hard to recognise: it bites whenever the extra
unit crosses a ceiling boundary, with probability roughly `tokenReserve / kasReserve`. Token-heavy pools
failed nearly every time; balanced pools failed intermittently, so the same code could work and then stop
working with no change on your side. Both directions (buy and sell) and every covenant schema are affected.

Curve trades were never affected — `curve_cp` has no retention term.

**Upgrading is the whole fix.** No API change, no call-site change.

If you cannot upgrade immediately, `buildPoolV3SwapKasForToken` itself is correct — only the quote handed to
it is wrong. Recompute the retention with a ceiling and pass the corrected quote:

```ts
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const weight = lpFeeBps * (totalShares - lockedShares);
const retainKas = weight <= 0n ? 0n : ceilDiv(kasInUnits * weight, 10000n * totalShares);
const newToken = ceilDiv(kasReserve * tokenReserve, kasReserve + kasInUnits - retainKas);
const q2 = { ...q, newToken, tokenOut: tokenReserve - newToken };
```

Fee outputs and `newKas` in the quote are already correct — leave them alone. Note the corrected quote returns
one retain-unit fewer tokens, so any pre-trade figure you display shifts very slightly.

### Fixed — the release parity gate now covers the pool path

This drifted silently because `scripts/verify-parity.mjs` compared only the **curve** builders against KRON's
production code. The pool quotes and builders were never checked, so the covenant could move without the gate
noticing. The gate now also compares `quotePoolCpBuy` / `quotePoolCpSell` across a spread of pool shapes and
trade sizes — including live mainnet pool states — because a single canonical case does not surface an
off-by-one whose visibility depends on the reserve ratio.

### Known issue — liquidity provision

`buildRemoveLiquidity` does not yet supply the pool's canonical LP-share inventory input required by current
covenant schemas, so **remove-liquidity is expected to be rejected on recently-launched pools**. Swaps, curve
trades and `addLiquidity` are unaffected. A fix is planned for the next release; if you need it sooner, say so.

## 0.13.0

### Added — partner attribution now works regardless of how you submit

If you're in KRON's wallet-integrator program, **this release is required to be paid correctly.**

Attribution used to be recorded by KRON's *sequencer*, at relay time. That coupled "does the partner get
credited" to "which submission route did the wallet choose" — and the route is chosen for latency and
reliability reasons, not accounting ones. With no contention on a token there is nothing to sequence, so a
sensible integrator submits straight to a node, and earned **nothing**. Reported by KasWare; they were right.

The tag now rides in the transaction payload, so it's part of the trade itself:

```ts
const asm = kron.spend.assembleNativeTx(k, {
  spend, fundingEntries, changeAddress, networkFee,
  ref: 'yourtag',            // ← on-chain attribution; works via sequencer OR direct-to-node
});
```

- **New:** `kron.partnerTag` — `encodePartnerTag(ref)`, `parsePartnerTag(payloadHex)`, `REF_RE`, `TAG_PREFIX`.
- **`spend.assembleNativeTx`** takes an optional `ref` and writes `kron:r:<tag>` into `tx.payload`.
- An invalid or absent tag yields an empty payload rather than throwing — so validate against `REF_RE` at your
  config boundary, because a silently-dropped tag earns nothing.
- **Audit your own volume from chain**, without trusting KRON's books:
  `GET https://idx.kron.technology/v1/kcc20/attribution?ref=<tag>`

Cost is negligible: the tag is 14 bytes for a 7-character ref, ~28 normalized transient mass, about
**0.000028 KAS** against a ~0.35 KAS network fee. No covenant reads or constrains `payload`, so this works on
every already-deployed token — no new covenant version, nothing to migrate.

The tag is unauthenticated by design (anyone can put any tag in their own transaction). It's a durable,
publicly auditable claim, not proof of origination; KRON settles by manual review.

**Still passing `ref` to `sequencerClient.submit()`/`curveSubmit()`?** Keep it — that path still records, and
KRON merges both sources deduped by txid. But it only ever sees sequencer-routed trades, so move to the
payload tag.

## 0.12.0

### Added — token-list platform-signature verification

- `verify.verifyTokenListSignature(kaspa, list, { pinnedPublicKey?, expectedVariant? })` and
  `verify.canonicalTokenListMsg` — verify the additive platform signature KRON's backend now attaches to
  `GET /api/registry/tokenlist` (`variant`/`signature`/`publicKey` root fields). The canonical message
  excludes the volatile `timestamp` and **binds the query variant**, so a signed `?all=1` document cannot be
  replayed as the curated default list. Key policy mirrors the pool-manifest verifier: a pinned key you
  obtained out-of-band always wins; without one the response key is used (trust-on-first-use, reported via
  `keySource`). Never throws; unsigned lists (older backends) report `{ ok: false, signed: false }`.
  Per-entry chain verification (`verifyTokenListEntry`) remains the root of trust — the signature
  authenticates list *metadata* against tampering between KRON and you (mirrors, CDN layers, saved copies).
- `TokenList` gained optional `variant` / `signature` / `publicKey` fields (additive; new types
  `SignedTokenList`, `TokenListVariant`, `VerifySignatureResult`, `KaspaMessageVerifier`).

### Changed — the release parity gate now fails closed

- `verify:parity` exits **1** when the private reference toolchain is missing, instead of skipping with
  exit 0. Environments that legitimately lack it (external forks, public CI) opt out explicitly with
  `KRON_PARITY_OPTIONAL=1`; a missing `dist/` build always fails regardless. `prepublishOnly` runs without
  the flag, so a publish from a machine that cannot verify parity fails rather than silently passing —
  closing the gap that let pre-0.10 releases ship covenant-rejected builders. The parity script also now
  asserts the token-list canonicalizer is byte-identical to the backend's (a cross-repo sign→verify
  round-trip), and public CI runs the vitest suite plus a fail-closed regression guard.

## 0.11.0

### Fixed — transactions were being rejected by the node's mempool

Two independent bugs, both of which produce a transaction the node refuses. Neither is a covenant problem —
the covenant scripts were correct — so both surfaced only at submit time, and both scale with transaction
size, meaning they reproduce on real trades and not on small test cases.

- **Fee was sized off the wrong mass dimension.** Toccata mass is 3-D `{storage, compute, transient}` and the
  node requires `fee >= normalized_mass × min-relay-feerate` for *every* dimension, where
  `normalized_i = ceil(raw_i × compute_limit / limit_i)`. The estimator only ever computed compute mass. For
  covenant trades transient **dominates** — the redeem scripts ride in `signatureScript`, so a curve trade
  serializes to ~175 KB and carries ~351k normalized transient against ~229k compute, *regardless of trade
  size*. The vendored kaspa-wasm predates this model and exposes no transient call, so it is now computed
  directly, mirroring `transaction_estimated_serialized_size` from the consensus source. The fee is sized off
  the largest dimension.
  Real rejection this fixes: `transaction has 34382100 fees which is under the required amount of 35114800 for
  normalized transient mass 351148`.
- **Per-input compute budgets were 5× too large.** `computeBudget` is a consensus-serialized `u16` costing 100
  grams of compute mass each, against a **500,000 cap that cannot be raised**. KRON right-sized its budgets
  (`COVENANT_COMPUTE` 2000 → 400, `TOKEN_COMPUTE` 500 → 100) after they pushed curve transactions over that
  cap; this SDK kept the old values. Now aligned. **This changes the serialized bytes of every covenant
  transaction the SDK builds.**
- `estimateNativeFee` now floors the feerate at the network minimum (100 sompi/gram, exported as
  `MIN_RELAY_FEERATE`) instead of 1 — a lower rate can never produce a relayable transaction.
- The mass-safety margin is now 1.2× over an exactly-mirrored mass, down from 1.5× over a guessed one.
- New export: `estimatedSerializedSize(tx)`.

### Fixed — the parity guard could not see either bug
`verify:parity` compares what the *builders* return, but compute budgets are applied at **assembly**, so the
divergence was structurally invisible to it — the SDK ran 2000 against KRON's 400 through every green parity
run. Budgets are now asserted directly against the reference source, and the check is negative-tested.

## 0.10.0

### Fixed — REQUIRED for mainnet: curve trades were being rejected on-chain

KRON's mainnet launch introduced a third trade-fee leg (the **dev fund**), carved out of the platform share
so the total fee is unchanged. It is a covenant ABI change: `curve_cp` now requires a P2PK output paying
`devFundOwner` at a **fixed** index — `[5]` on a buy, `[4]` on a sell — and validates it unconditionally.

Through 0.9.1 this SDK had no knowledge of that leg. Every curve buy and sell it built was missing the
required output and was **rejected by consensus**. Because mainnet launched with an empty registry, every
mainnet token carries the dev-fund schema, so this affected all mainnet curve trading. Pool swaps were
unaffected (the AMM covenant has no dev-fund leg).

- **`curveCpTx.buildCpBuy` / `buildCpSell`** now emit the dev-fund output when the template carries the leg.
  On a fractional sell the covid-A change output shifts to `[5]`, since index `[4]` is covenant-fixed.
- **`CpParams`** gains optional `devFundOwner` / `devFundBps`. The leg is emitted **only** when both are
  present: omitting them on a dev-fund token builds a rejected transaction, and adding them to an old-pinned
  token silently donates the bps. Forward the registry's `curveParams` verbatim and this resolves itself.
- **`quoteCpBuy` / `quoteCpSell`** account for the leg. Quotes now carry a `devFundFee` field and fold it
  into `fee`/`total`/`net`; previously a buy quote under-funded the transaction it was used to build.
- **`CpCurveParamsRecord`** (registry client) gains `devFundOwner` / `devFundBps` so the passthrough typechecks.

Old-pinned (pre-dev-fund) tokens are unaffected — both shapes are covered by the parity check below.

### Fixed — the guard that should have caught this
- **`verify:parity`** was itself failing to run: its constructor arguments predated the vesting-template,
  batch-order and dev-fund ABI changes, so `silverc` aborted with a count mismatch before any comparison
  happened. It is updated to the current ABI and now checks buy/sell against **both** the dev-fund and the
  legacy two-fee shapes. Note this check silently skips (exit 0) wherever the covenant toolchain is absent,
  which includes CI — it only truly gates a release when run against a local kron checkout.

## 0.9.1

### Fixed
- **`poolCpTx.buildBindLp`** now genesis-mints ONLY the pool's issuable L-share inventory (the single-output
  "Option A" shape). Previously it also minted a `lockedShares` floor balance owned by an all-zero covenant
  id, intended as an unspendable "burn" — but a plain (non-covenant) input satisfies the covenant-id-zero
  ownership check, so that floor balance was actually spendable. The permanently-locked floor is no longer
  tokenized at all; it exists purely as an on-chain invariant (a counter + a withdrawal guard) backed by the
  pool's own reserves, so there is no longer an object to seize. Matches the corresponding fix already live
  in KRON's deployed `amm_pool_cp_v3.sil` — this SDK version is required to build a `bindLp` transaction the
  current on-chain covenant will accept (the old two-output shape is now rejected).
- **`quotePoolCpBuy`/`quotePoolCpSell`** now compute the voluntary-LP swap-fee retention (`retainKas`) in one
  precise step, matching the covenant exactly. The previous formula pre-floored an intermediate basis-point
  rate before applying it, which rounded to zero for any pool under roughly 5% voluntary liquidity (at the
  default 20bps LP fee) — silently under-quoting the fee a swap must retain in-pool for those pools.

## 0.9.0

### Added
- **Per-token wallet history** — `client.IndexerClient.tokenAddressTrades(tick, address, opts?)` wraps the
  new `GET /token/{tick}/address/{address}/trades` indexer endpoint: one address's trade history on one
  token (the token-detail history view a wallet shows its user). Paginated via `offset`/`limit`.

### Fixed
- `IndexerClient.addressTrades` now accepts optional `{ offset, limit }` pagination (the backend always
  supported it; the client method previously dropped it).

## 0.8.0

### Changed — wallet discovery now implements KIP-12 directly (BREAKING wire values)

The SDK's discovery surface (`src/wallet/discovery.ts`) is now a self-contained implementation of
[KIP-12](https://github.com/kaspanet/kips/pull/21), the Kaspa wallet provider and discovery standard —
the KIP is the authoritative spec. The `kaspa-wallet-standard` package dependency is removed (that
package remains a standalone reference implementation of the same KIP; nothing depends on it here).

- Export names are unchanged (`announceKaspaWallet`, `requestKaspaWallets`, `KASPA_NETWORKS`,
  `KaspaProvider`, …) — existing imports keep compiling.
- **Wire values are now KIP-12 canonical** (breaking if you compared against literals):
  announce event `kaspa:provider` (was `kaspa:announceProvider`); network ids `mainnet` /
  `testnet-10` / `testnet-11` / `devnet` (were `kaspa_`-prefixed); provider change event
  `chainChanged` (was `networkChanged`).
- New export: `normalizeKaspaNetworkId()` — maps `kaspa_`-prefixed dialects (e.g. KasWare's injected
  API) to the canonical ids.
- **`KaspaProviderInfo` now requires `id` and `methods`** — KIP-12's required announce fields
  (`methods` advertises the wire methods a wallet serves before the user ever connects). Wallets
  announcing through `announceKaspaWallet()` must supply both; dApp-side `requestKaspaWallets()`
  stays lenient and still surfaces announces without them.

## 0.7.1

### Fixed — build-time guards for footguns that produced transactions rejected on-chain

A hardening pass from a community audit by **ghostDAG** (Kaspa ecosystem developer). Four builders could
return a transaction that looked valid locally but failed at broadcast; they now fail fast at build time
with a clear error instead. No valid caller is affected.

- `curveCp.buildCpBuy` / `poolCpV3.buildPoolV3SwapKasForToken` — the `presenceWitnessIdx` parameter
  defaulted to `0`, which is the covenant input (curve/pool P2SH). When merging the buyer's existing
  holdings (`mergeTokens` non-empty), those tokens are presence-owned and need a co-present signed P2PK
  funding input as their witness — pointing at input 0 (which carries no signature) failed the on-chain
  presence check. Both now throw when `mergeTokens` is non-empty and `presenceWitnessIdx` is still 0. A
  plain buy/swap with no merge is unaffected.
- `curveCp.buildSplitToken` / `buildConsolidate`, `vesting.buildVestingClaim` / `buildVestingClaimFinal` —
  `opts.tokenCovid` was optional, but without it the outputs carry no KIP-20 `CovenantBinding`, so the
  covenant's `OpCovOutputCount` check sees zero outputs and the transfer fails on-chain. It is now required;
  these builders throw when it is missing.

### Fixed — misc

- `curve.minOutWithSlippage` clamps its `bps` argument to `[0, 10000]`, so an out-of-range slippage
  tolerance can no longer produce a negative minimum output.
- The example wallet adapter's `getXOnlyPublicKey` now derives the x-only key correctly from an
  **uncompressed** (65-byte) pubkey — it previously returned the trailing Y coordinate instead of X.
  Compressed (33-byte) and raw x-only (32-byte) keys were already handled correctly.

No changes to any signature script, redeem script, or output value — assembled transactions remain
byte-identical to the reference builders. Thanks to **ghostDAG** for the report.

## 0.7.0

### Added — Kaspa provider discovery (EIP-6963-style announce/request events)

A tiny window-event handshake so any Kaspa wallet can surface itself to any adopting dApp with **zero
dApp-side code changes** — no more integrating wallets one at a time on either side. This SDK re-exports
it from a new standalone, zero-dependency package,
[`kaspa-wallet-standard`](https://github.com/kaspa-wallet-standard/kaspa-wallet-standard) — a *proposed*
cross-ecosystem standard (headed for a KIP) that any wallet or dApp can adopt without depending on KRON.
kron-sdk is its first adopter and re-exports the full surface, so it stays the single source of truth.

- Events: `kaspa:announceProvider` (wallet → dApp, frozen `{ info, provider }` detail) and
  `kaspa:requestProvider` (dApp → wallets, replay request). Constants
  `KASPA_ANNOUNCE_PROVIDER_EVENT` / `KASPA_REQUEST_PROVIDER_EVENT`.
- Types: `KaspaProviderInfo` (`uuid` per-load, `name`, `icon` data-URI, stable `rdns`),
  `KaspaProvider` (KasWare-shaped raw surface; only `requestAccounts` mandatory — everything else is
  capability-checked by dApps), `KaspaProviderDetail`.
- Helpers: `announceKaspaWallet(info, provider)` (wallet side — announce now + auto-replay on every
  request; returns unsubscribe) and `requestKaspaWallets(onAnnounce)` (dApp side — subscribe + request;
  returns unsubscribe). Both are window-guarded no-ops in Node.
- `WalletAdapter` gains optional `icon?: string` (data-URI, for wallet pickers) and
  `onAccountsChanged?(handler): () => void` (account-switch subscription).
- `docs/WALLETS.md`: new "Discovery: announce your wallet to dApps" section — payload spec, replay
  semantics, canonical network ids, a no-dependency ~10-line raw-JS announce snippet, security notes,
  and the compatibility contract.

**Compatibility contract:** the discovery spec is frozen at publication — event names and existing
payload fields never change; evolution is by new optional fields only. Everything in this release is
additive: adapters and integrations built against 0.6.x work unchanged.

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
