# kron-sdk

**Build, sign, and submit transactions against [KRON](https://kron.technology)'s native-L1 Kaspa covenants
— a bonding-curve launchpad + AMM DEX — from any JS/TS environment.** Browser or Node. No custody, ever:
this package only *builds* transactions; a wallet (yours, or your user's) signs them.

> **Status: v0.14.3, mainnet.** Read paths and the covenant builders are proven byte-identical to
> KRON's own production code (see "Verification" below). Wallet signing is a documented interface plus a
> generic reference implementation — see [`docs/WALLETS.md`](docs/WALLETS.md) for the contract (which is
> [KIP-12](https://github.com/kaspanet/kips/pull/44)) and how to adapt it to a specific wallet's injected
> provider.
>
> ⚠️ **Install `@latest` — do not pin an older release.** Every release before 0.14.1 has at least one bug
> that either gets transactions **rejected on-chain** or produces a **wrong quote**. The floors, newest
> first (full detail per version in the [CHANGELOG](CHANGELOG.md)):
>
> - **≤ 0.14.0** — small-sell quotes could return a **negative `net`** (the seller pays to sell); since
>   0.14.1 `quoteCpSell`/`quotePoolCpSell` return `null` there instead — treat it as "amount too small
>   to sell", not an error.
> - **≤ 0.13.3** — curve builders (`buildCpBuy`/`buildCpSell`/`buildCpGraduate`) defaulted an unset
>   `tokenDust` to a sub-dust value that blows the mass cap (0.13.3 fixed only the pool builders).
> - **≤ 0.13.1** — `buildRemoveLiquidity` built a shape every live pool rejects.
> - **≤ 0.13.0** — pool swaps rejected with `script ran, but verification failed` (fee rounding floored
>   where the covenant takes a ceiling).
> - **≤ 0.10.0** — network fee under-paid / compute over-declared → mempool rejection; **≤ 0.9.1** also
>   omits the dev-fund fee output every mainnet curve token requires → covenant rejection.
> - **< 0.6.0** — built version-0 transactions with no covenant bindings; nothing that old can produce a
>   valid spend at all.
>
> **Two gates every integrator must implement** (both enforced by current code, but you have to call them):
>
> - Gate `poolCp.buildAddLiquidity` on **`IndexerClient.assertLpBindSafe(tick)`**. Pools that graduated
>   before the counterfeit-LP covenant guard can be counterfeit-bound so that added liquidity is drained;
>   the check throws unless the pool's LP shares are provably honest. Removing liquidity needs no gate.
> - Fetch the live curve UTXO via **`SequencerClient.curveHead(curveCovid)`**, not by deriving the curve's
>   address from indexer state — see the Quickstart below and `docs/INTEGRATION.md` §4 "Curve state".

## Why this exists

KRON is **covenant-native** — there's no rollup, no off-chain ledger of record, no custodial API. Every
balance is an on-chain UTXO whose script enforces its own rules; every state-changing action is a
transaction **the user's own wallet signs**. That's great for trust, but it means "integrate with KRON"
has historically meant embedding KRON's browser bundle. This package extracts the transaction builders for
**trading against already-deployed KRON tokens** into a standalone, dependency-light package, so a wallet,
a Telegram bot, or a backend can build those transactions directly — buy, sell, swap, transfer, add/remove
liquidity, claim vesting.

This package does **not** include a covenant compiler and doesn't build the deploy/genesis transactions
that launch a *new* curve, pool, or token — see "What's in the box" below.

## Install

```bash
npm install @kronsdk/kron-sdk
```

## Docs

- **[docs/BUILDING-TRADES.md](docs/BUILDING-TRADES.md)** — end-to-end transfer / buy / sell / swap: which
  call goes to the backend (compile) vs. the SDK (assemble), and the per-trade sequence. Also covers
  **partner attribution** (tagging trades so integrator volume is credited). **Start here for trading.**
- **[docs/INTEGRATION.md](docs/INTEGRATION.md)** — the full integration surface: endpoints, clients, data shapes.
- **[docs/WALLETS.md](docs/WALLETS.md)** — the wallet provider + discovery contract (KIP-12) and how to adapt it.

ESM only (`"type": "module"`) in v1 — see [Design notes](#design-notes) for why.

**Updating.** Already installed? Pull the latest published release:

```bash
npm install @kronsdk/kron-sdk@latest      # newest
npm install @kronsdk/kron-sdk@0.14.3      # or pin an exact version for reproducible builds
```

The package follows semver — **just install `@latest`**; there's no reason to pin an older release. Anything
below 0.6.0 can't build valid curve/pool/LP/vesting transactions (see the warning above), so avoid pinning
below it. The token-list client (`client.RegistryClient.tokenlist()`) and on-chain verifier
(`verify.verifyTokenListEntry`) have been available since **0.2.0** — see [Discover & verify tokens](#discover--verify-tokens-token-list).

## Quickstart — quote a curve buy (Node)

```ts
import * as kron from '@kronsdk/kron-sdk';
import { loadKaspa } from '@kronsdk/kron-sdk/wasm';

const k = await loadKaspa();
const idx = new kron.client.IndexerClient('https://idx.kron.technology/v1/kcc20');
const reg = new kron.client.RegistryClient('https://api.kron.technology');

// 1. Live curve state comes from the INDEXER; the baked fee/curve params come from the REGISTRY.
//    They are two different sources — the indexer's token record carries no `curveParams`.
const token = await idx.token('ghost');
const entry = (await reg.tokenlist()).tokens.find((t) => t.symbol.toLowerCase() === 'ghost');
const p = entry.extensions.curveParams;

// 2. Fees are BAKED PER TOKEN at launch and differ between tokens — always read them from `curveParams`,
//    never hardcode them. `devFundBps` is absent on older tokens; `?? 0n` is the correct handling.
const cpState = {
  realKas: BigInt(token.cpState.realKas), tokenReserve: BigInt(token.cpState.tokenReserve),
  vKas: BigInt(p.vKas), graduationKas: BigInt(p.graduationKas),
  creatorFeeBps: BigInt(p.creatorFeeBps), platformFeeBps: BigInt(p.platformFeeBps),
  devFundBps: BigInt(p.devFundBps ?? 0),
};

// 3. Quote a buy
const quote = kron.curve.quoteCpBuy(cpState, 10_000_000_000n); // 100 KAS in
if (!quote) throw new Error('quote failed — bad amount or curve state');
console.log(`100 KAS -> ${quote.tokenOut} tokens, fee ${quote.fee} sompi`);

// Selling: ALWAYS handle the null. Every fee output is padded to a 0.2 KAS floor, so a small sell can cost
// more in fixed fees than it returns. Since 0.14.1 `quoteCpSell` returns null there rather than a quote with
// a negative `net` — treat null as "amount too small to sell", not as an error.
const sell = kron.curve.quoteCpSell(cpState, 5_000n);
if (!sell) console.log('too small to sell — the fixed fee outputs cost more than this returns');

// 4. Build the covenant spend against the LIVE curve. `cpTemplate`/`tokenTemplate` need the target's
//    already-compiled script bytes + state offset — read them from your indexer's UTXO data
//    (redeemScriptHex etc.), this package doesn't compile them.
//
//    curveUtxo/inventoryUtxo: fetch these via `client.SequencerClient.curveHead(curveCovid)`, NOT by
//    deriving the curve's address yourself from the indexer's `cpState.tokenReserve` and searching for
//    its UTXO — the curve's on-chain address changes on every trade (tokenReserve is spliced into the
//    redeem script), so that derive-then-search races the indexer's poll lag and intermittently fails
//    with "no curve UTXO found" on busy curves. `curveHead()` returns the current spendable outpoint
//    (confirmed or still-unconfirmed) directly. See docs/INTEGRATION.md §4 "Curve state" + §6 for the
//    full flow, including the indexer-only fallback if you can't reach the sequencer.
// const spend = kron.curveCp.buildCpBuy(k, cpTemplate, tokenTemplate, curveUtxo, inventoryUtxo, ...);
// const asm = kron.spend.assembleNativeTx(k, { spend, fundingEntries, changeAddress, networkFee });
// const pskt = kron.spend.toPsktJson(asm);
// const signed = await wallet.signPskt(pskt.txJsonString, pskt.signInputs); // user's wallet signs
```

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the full read/write API + worked recipes (wallet
portfolio render, "Send" button, TG bot price command, pool swap).

## Discover & verify tokens (token list)

**Available since 0.2.0.** KRON publishes a [tokenlists.org](https://tokenlists.org)-shaped **token
list** — one URL a wallet, explorer, or price aggregator can read to discover every KRON token and how to
identify it, instead of hand-rolling registry calls. Covenant tokens are new to the ecosystem, so this is
the bridge that lets existing tooling recognize them. `client.RegistryClient.tokenlist()` returns it typed.

Every entry is **independently verifiable against the chain** — it carries its `covenantId` (the canonical
token id) plus a `genesisTxid` proof pointer, and `verify.verifyTokenListEntry` confirms the token was
genuinely created on that transaction. A spoofed entry can't slip through, and trust is rooted in Kaspa,
not in KRON's server.

The list is additionally **platform-signed** (backends since 2026-07-27): the envelope carries `variant`/
`signature`/`publicKey` root fields, and `verify.verifyTokenListSignature` checks them — this authenticates
list *metadata* (names, logos) against tampering between KRON and you (mirrors, CDN layers, saved copies).
The canonical message excludes the volatile `timestamp` and **binds the query variant**, so a signed
`?all=1` document can't be replayed as the curated default list. Pin KRON's publish key out-of-band and
pass it as `pinnedPublicKey`; per-entry chain verification above remains the root of trust.

```ts
import { client, verify } from '@kronsdk/kron-sdk';

const reg = new client.RegistryClient('https://api.kron.technology');
const list = await reg.tokenlist();                 // { name, version, network, tokens } — verified-only
// const all = await reg.tokenlist({ all: true });  // include unverified, each tagged chainVerified:false

// Verify each entry against the chain before trusting it. `fetchTx` is INJECTED — the SDK ships no Kaspa
// node client; kaspaRestFetchTx wraps the common REST shape (or pass your own node RPC / proxy).
const fetchTx = verify.kaspaRestFetchTx('https://api.kaspa.org');   // mainnet
const safe = [];
for (const entry of list.tokens) {
  const r = await verify.verifyTokenListEntry(entry, fetchTx);   // { ok, covenantIdPresent, reason? }
  if (r.ok) safe.push(entry);
}

// Check the list-level platform signature (metadata integrity — additive to the per-entry check above).
import { loadKaspa } from '@kronsdk/kron-sdk/wasm';
const kaspa = await loadKaspa();
const sig = verify.verifyTokenListSignature(kaspa, list, {
  pinnedPublicKey: KRON_TOKENLIST_PUBKEY,   // pin out-of-band (docs/INTEGRATION.md); omit for trust-on-first-use
  // expectedVariant: { all: true },        // pass the variant you actually requested (default: curated list)
});
if (!sig.ok) console.warn(`token list signature: ${sig.reason}`);   // sig.signed=false ⇒ older, unsigned backend
```

`covenantId` (covid `A`) is the **token** id — what a wallet adds/tracks. `extensions.poolCovenantId`
(covid `P`) is the **pool/pair** id, non-null only post-graduation — what a DEX aggregator lists. The
verifier can't re-derive the covenant script from params (this package has no compiler); the
covenant-id-on-genesis check is the achievable, sufficient anti-spoof proof. Full schema:
[`docs/INTEGRATION.md`](docs/INTEGRATION.md).

`extensions.templateVersion` (0.6.1+) is the token's **covenant version pin** `{ schema, silverc }` —
KRON pins each token to the covenant source set it was deployed under (template pinning), so future
covenant upgrades can't strand deployed tokens. An auditor recompiling the covenant from
`extensions.curveParams` must compile **that** version's sources (archived at
`covenants/versions/<schema[0..12]>/` in the kron repo — private; ask us for the sources of a given
schema), not the newest ones. `null` = pre-pinning legacy
entry. The on-chain verifier above is version-independent and needs none of this.

## What's in the box

```
kron-sdk
├─ curve            constant-product curve math (BigInt, mirrors curve_cp.sil exactly)
├─ curveCp           curve_cp builders against an EXISTING curve: buy / sell / graduate
├─ poolCp / poolCpV3 amm_pool_cp_v3 builders: swap / addLiquidity / removeLiquidity / bindLp
├─ kcc20              the KCC-20 token covenant: transfer / ownership modes / state encoding
├─ vesting            claim / claimFinal against an EXISTING vesting lock
├─ spend              tx assembly + the signPskt-style wallet-signing bridge
├─ partnerTag         on-chain integrator attribution: encode/parse the partner tag carried in tx.payload
├─ wallet             WalletAdapter interface, a generic reference adapter, + cross-wallet provider discovery
├─ client             typed REST clients: indexer, registry (incl. tokenlist()), sequencer
├─ verify             verify a token-list entry against the chain (anti-spoof, fetcher-injected)
└─ /wasm              loadKaspa() — the only environment-specific (Node vs browser) export
```

Every builder here operates against an **already-deployed** covenant instance — it takes the target's
current compiled script bytes (read from your indexer, e.g. a UTXO's `redeemScriptHex`) and splices in the
new state. This package does not include the covenant `.sil` sources or a compiler, and doesn't build the
genesis/deploy transactions that create a *new* curve, pool, or token — only KRON's own deploy tooling does
that.

Full guide: [`docs/INTEGRATION.md`](docs/INTEGRATION.md). Wallet-adapter contract:
[`docs/WALLETS.md`](docs/WALLETS.md).

## Verification

This package's covenant builders are **ported, not rewritten**, from KRON's own production code
(`web/src/native/*`), which is exercised by an offline VM-verifier suite in the private KRON repo (covenant
transitions run against the real Kaspa txscript engine). `scripts/e2e-offline-flow.mjs` exercises the full
builder chain here offline (quote math, state-splicing, tx assembly, and the wallet-signing bridge) against
a synthetic template, and checks the one property that matters most for fund safety: signing touches
**only** the funding input, never a covenant input.

What this package does **not** independently verify: full VM-level execution of the covenant scripts (that
requires the Kaspa `cli-debugger` + the private KRON repo's verifier suite, which also holds the covenant
sources and compiler this package doesn't ship) and on-chain broadcast (no network access from a clean
install). If you're integrating funds-critical logic, treat `scripts/e2e-offline-flow.mjs` as a smoke test,
not a substitute for a real transaction. **There is no KRON testnet** — TN10 was retired at the mainnet
migration — so validate the write path with one small mainnet trade before shipping. Reads and transaction
*building* need no funds: the registry, the indexer and the template-compile endpoint are all public.

The strongest guarantee here is **byte-parity**: `npm run verify:parity` compiles the live covenant sources
and asserts that this package's builders produce transactions byte-identical to KRON's production builders —
across both the dev-fund and legacy fee ABIs — and that the per-input compute budgets match. It runs
automatically in `prepublishOnly`. It needs the (private) KRON repo and the covenant compiler checked out
locally, and **fails closed (exit 1) when they're absent**. Environments that legitimately lack the private
toolchain — external forks, public CI — set `KRON_PARITY_OPTIONAL=1` to skip with a visible notice instead;
the flag never excuses a missing `dist/` build, and is a no-op when the toolchain is present, so it cannot
mask a real mismatch. `prepublishOnly` runs *without* the flag: a publish from a machine that cannot verify
parity fails rather than silently passing. (This repo's own CI sets the flag — a green public CI run means
"parity deferred to publish time", not "parity checked".)

```bash
npm run build && node scripts/smoke-test-node-wasm.mjs   # WASM loads + basic SDK calls work in plain Node
node scripts/e2e-offline-flow.mjs                        # offline builder-chain sanity check
npm test                                                 # unit tests (quote math, token-list verify, discovery)
npm run verify:parity                                    # byte-parity vs KRON production builders
```

## What a trade actually costs

Worth designing around, because it surprises people. A KRON covenant transaction is **large** — the redeem
scripts are revealed in `signatureScript`, so a curve trade serializes to roughly **175 KB regardless of the
trade amount**. Two consequences:

- **Network fee ≈ 0.35 KAS per trade**, driven by transient mass (serialized size), not by trade size.
- **Protocol fee has a floor.** Each fee leg is a separate output and Kaspa enforces a minimum output value,
  so each is padded to 0.2 KAS — about **0.6 KAS minimum on a curve trade**, 0.4 KAS on a pool swap.

All in, expect **roughly 1 KAS of fixed cost per trade whatever its size**. The headline 1.25% curve rate is
only achieved on larger trades; a 10 KAS trade pays closer to 10%. If you surface a fee percentage in your
UI, compute it from the quote's actual amounts (`quote.fee`, `quote.total`) rather than from the bps — the
quote object itemises every leg. Consider a minimum trade size.

## Partner attribution (wallet-integrator program)

Integrators in KRON's [wallet partner program](https://kron.technology/wallets) earn a revenue share on the
volume they route. Since **0.13.0** the attribution tag travels **in the transaction itself**, so trades are
credited however you submit them — through the sequencer or straight to a node:

```ts
const asm = kron.spend.assembleNativeTx(k, {
  spend, fundingEntries, changeAddress, networkFee,
  ref: 'yourtag',   // your partner tag → written to tx.payload as `kron:r:yourtag`
});
```

Audit your credited volume straight from chain —
`GET https://idx.kron.technology/v1/kcc20/attribution?ref=yourtag` — and validate your tag with
`kron.partnerTag.REF_RE` at your config boundary (an invalid tag is silently dropped and earns nothing).
Costs ~0.00003 KAS per trade; no covenant logic is touched. Full details:
[docs/BUILDING-TRADES.md § Partner attribution](docs/BUILDING-TRADES.md#partner-attribution-integrator-program).

## Design notes

- **ESM-only in v1.** The vendored wasm-bindgen glue (`kaspa.js`) is ESM with a top-level `import.meta.url`
  reference; a dual CJS build would need its own async-import indirection for marginal benefit given most
  modern bot/backend frameworks are ESM-first. Open an issue if this blocks you.
- **Namespaced exports**, not flat. `curve/cpCurve.ts` and `native/curveCpTx.ts` both define their own
  `SCALE`; builder names like `buy`/`sell`/`transfer` are generic enough to collide with your own code. So:
  `import * as kron from '@kronsdk/kron-sdk'` then `kron.curve.quoteCpBuy(...)`, `kron.curveCp.buildCpBuy(...)`.
- **No covenant compiler.** Builders take a target's already-compiled script bytes (`{script, stateStart}`)
  as input rather than compiling from source — read these from your indexer's live UTXO data. This package
  can build transactions against existing KRON tokens; it can't compile or deploy a new curve/pool/token.

## License

MIT — see [`LICENSE`](LICENSE). Vendored third-party component (the Kaspa WASM SDK) is ISC-licensed; see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
