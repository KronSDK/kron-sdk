# kron-sdk

**Build, sign, and submit transactions against [KRON](https://kron.technology)'s native-L1 Kaspa covenants
— a bonding-curve launchpad + AMM DEX — from any JS/TS environment.** Browser or Node. No custody, ever:
this package only *builds* transactions; a wallet (yours, or your user's) signs them.

> **Status: v0.9.1, testnet (TN10).** Read paths and the covenant builders are proven byte-identical to
> KRON's own production code (see "Verification" below). Wallet signing is a documented interface plus a
> generic reference implementation — see [`docs/WALLETS.md`](docs/WALLETS.md) for the contract and how to
> adapt it to a specific wallet's injected provider. **0.7.0** added cross-wallet **provider discovery**
> (announce/request events) so any Kaspa wallet can surface itself to any dApp with no per-wallet code;
> **0.7.1** hardened the trade builders to fail fast on a few footgun inputs; **0.8.0** cut the discovery
> surface over to [KIP-12](https://github.com/kaspanet/kips/pull/21) canonical wire values and announce
> fields (breaking if you compared against the old literals — see the [CHANGELOG](CHANGELOG.md));
> **0.9.0** added per-token wallet trade history (`IndexerClient.tokenAddressTrades`) plus pagination on
> `addressTrades`; **0.9.1** fixes `buildBindLp` to match KRON's current on-chain pool covenant (the old
> shape is now rejected on-chain) and corrects a voluntary-LP fee-quoting rounding issue in
> `quotePoolCpBuy`/`quotePoolCpSell` for pools under ~5% voluntary liquidity — see the
> [CHANGELOG](CHANGELOG.md).
>
> **⚠️ On an old pinned version? `npm install @kronsdk/kron-sdk@latest`.** Releases before 0.6.0 built
> **version-0** transactions, which cannot carry the covenant bindings Kaspa's covenant layer (KIP-20)
> requires on output — every assembled spend was rejected on-chain with `script ran, but verification
> failed`. That was fixed across 0.5.0–0.6.0 (all builders now attach the required `CovOutput.binding`
> automatically), so any current release is safe and **`@latest` is all you need** — don't pin below 0.6.0.
> The per-version [CHANGELOG](CHANGELOG.md) migration notes only matter if you'd been assembling
> transactions by hand instead of via `spend.assembleNativeTx`.

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
  call goes to the backend (compile) vs. the SDK (assemble), and the per-trade sequence. **Start here for
  trading.**
- **[docs/INTEGRATION.md](docs/INTEGRATION.md)** — the full integration surface: endpoints, clients, data shapes.
- **[docs/WALLETS.md](docs/WALLETS.md)** — the wallet provider + discovery contract (KIP-12) and how to adapt it.

ESM only (`"type": "module"`) in v1 — see [Design notes](#design-notes) for why.

**Updating.** Already installed? Pull the latest published release:

```bash
npm install @kronsdk/kron-sdk@latest      # newest
npm install @kronsdk/kron-sdk@0.9.1       # or pin an exact version for reproducible builds
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

// 1. Read live curve state
const token = await idx.token('ghost');
const cpState = {
  realKas: BigInt(token.cpState.realKas), tokenReserve: BigInt(token.cpState.tokenReserve),
  vKas: BigInt(token.cp?.curveParams?.vKas ?? 0), graduationKas: BigInt(token.cp?.curveParams?.graduationKas ?? 0),
  creatorFeeBps: 25n, platformFeeBps: 100n,
};

// 2. Quote a buy
const quote = kron.curve.quoteCpBuy(cpState, 10_000_000_000n); // 100 TKAS in
if (!quote) throw new Error('quote failed — bad amount or curve state');
console.log(`100 TKAS -> ${quote.tokenOut} tokens, fee ${quote.fee} sompi`);

// 3. Build the covenant spend against the LIVE curve. `cpTemplate`/`tokenTemplate` need the target's
//    already-compiled script bytes + state offset — read them from your indexer's UTXO data
//    (redeemScriptHex etc.), this package doesn't compile them. curveUtxo/inventoryUtxo also come from
//    the indexer. See docs/INTEGRATION.md for the full flow.
// const spend = kron.curveCp.buildCpBuy(k, cpTemplate, tokenTemplate, curveUtxo, inventoryUtxo, ...);
// const asm = kron.spend.assembleNativeTx(k, { spend, fundingEntries, changeAddress, networkFee });
// const pskt = kron.spend.toPsktJson(asm);
// const signed = await wallet.signPskt(pskt.txJsonString, pskt.signInputs); // user's wallet signs
```

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the full read/write API + worked recipes (wallet
portfolio render, "Send" button, TG bot price command, pool swap).

## Discover & verify tokens (token list)

**New in this release.** KRON now publishes a [tokenlists.org](https://tokenlists.org)-shaped **token
list** — one URL a wallet, explorer, or price aggregator can read to discover every KRON token and how to
identify it, instead of hand-rolling registry calls. Covenant tokens are new to the ecosystem, so this is
the bridge that lets existing tooling recognize them. `client.RegistryClient.tokenlist()` returns it typed.

Because the list is **not platform-signed**, every entry is **independently verifiable against the chain** —
it carries its `covenantId` (the canonical token id) plus a `genesisTxid` proof pointer, and
`verify.verifyTokenListEntry` confirms the token was genuinely created on that transaction. A spoofed entry
can't slip through, and trust is rooted in Kaspa, not in KRON's server.

```ts
import { client, verify } from '@kronsdk/kron-sdk';

const reg = new client.RegistryClient('https://api.kron.technology');
const list = await reg.tokenlist();                 // { name, version, network, tokens } — verified-only
// const all = await reg.tokenlist({ all: true });  // include unverified, each tagged chainVerified:false

// Verify each entry against the chain before trusting it. `fetchTx` is INJECTED — the SDK ships no Kaspa
// node client; kaspaRestFetchTx wraps the common REST shape (or pass your own node RPC / proxy).
const fetchTx = verify.kaspaRestFetchTx('https://api-tn10.kaspa.org');
const safe = [];
for (const entry of list.tokens) {
  const r = await verify.verifyTokenListEntry(entry, fetchTx);   // { ok, covenantIdPresent, reason? }
  if (r.ok) safe.push(entry);
}
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
`covenants/versions/<schema[0..12]>/` in the kron repo), not the newest ones. `null` = pre-pinning legacy
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
not a substitute for testing against TN10 yourself before going to production.

```bash
npm run build && node scripts/smoke-test-node-wasm.mjs   # WASM loads + basic SDK calls work in plain Node
node scripts/e2e-offline-flow.mjs                          # offline builder-chain sanity check
```

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
