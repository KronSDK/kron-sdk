# KRON integration guide

> Testnet (TN10) integration surface. Endpoints and shapes below are stable enough to build against; a few
> details may still shift ahead of mainnet.

This guide is for anyone integrating KRON — wallets, Telegram bots, explorers, analytics, trading UIs. The
running examples are framed around a **wallet extension** and a **Telegram bot** because those are the two
most common shapes, but every primitive here is general-purpose.

---

## 1. Mental model (read this first)

KRON is a **covenant-native launchpad + DEX on Kaspa L1**. There is no rollup, no L2, no off-chain ledger of
record.

- **Tokens are covenant UTXOs.** A KCC-20 balance is an on-chain UTXO whose script enforces its own
  ownership and supply rules. Moving it is a covenant `transfer`; conservation (sum in == sum out) is
  checked *in script* by L1 consensus.
- **The indexer is a read layer, not the source of truth.** It follows the node's accepted-tx stream and
  exposes a fast, queryable view of state. If it went away, nothing is lost — the state is on-chain and
  reconstructable. This matters for integrators: **you never have to trust the indexer for correctness of
  funds**, only for convenience of querying. (Contrast with KRC-20 / Kasplex, where the off-chain indexer
  *is* the ledger.)
- **Two phases per token.** A token launches on a **bonding curve** (`curve_cp`), and once it raises its
  graduation target it **graduates** into a **constant-product AMM pool** (`amm_pool_cp_v3`). Reads and
  trades differ slightly by phase — see §4.
- **Non-custodial throughout.** Every state-changing action is a transaction the **user's own wallet
  signs**. Neither KRON's backend nor this SDK ever holds keys or funds.

### What you read vs. what you write

| | How | Trust model |
|---|---|---|
| **Reads** (balances, prices, holdings, pool state, history) | Simple REST + SSE against the indexer, or `kron-sdk`'s typed clients (`IndexerClient`, `RegistryClient`) | Convenience layer; verifiable against chain |
| **Writes** (buy, sell, transfer, swap, LP) | Build a covenant tx with `kron-sdk`, have the **user's wallet** sign it, submit to the node (or the sequencer for hot-pool swaps) | Fully non-custodial; consensus-enforced |

For a wallet or bot, **most of what you need is reads** (display balances, prices, portfolios) plus the
**transfer** and **buy/sell/swap** write paths. Reads are trivial REST. Writes need `kron-sdk`'s covenant
tx-builders (§5) — that's what this package is for.

---

## 2. Network & endpoints (TN10)

All services are live on Kaspa **testnet-10**.

| Service | Base URL | Purpose |
|---|---|---|
| **Indexer** (KCC-20 API) | `https://idx.kron.technology` | Balances, metadata, prices, holders, pool state, history, SSE. Path prefix `/v1/kcc20`. |
| **Backend** (registry) | `https://api.kron.technology` | Token metadata registry (name/image/links/socials), LP positions, comments, alerts. |
| **Sequencer** | `https://seq.kron.technology` | Non-custodial batcher for **post-graduation pool swaps** under contention. Pool-only. |
| **Node** (wRPC) | `wss://node.kron.technology` | Kaspa wRPC (borsh) over wss — UTXO set, submit tx. `testnet-10`. |
| **Frontend** | `https://kron.technology` | Reference UI (useful for cross-checking behavior). |

`network` everywhere = `testnet-10`. Mainnet endpoints will be published separately at launch — the
`kron-sdk` REST clients take `baseUrl` as an explicit constructor argument (no baked-in default) so
switching networks is a one-line change, not a version bump.

---

## 3. Core concepts & wire format

### Response envelope (indexer)

The indexer mirrors the KRC-20 REST shape so existing Kaspa tooling adapts with minimal changes:

```json
{ "message": "successful", "result": [ ... ] }
```

`result` is an array for list/meta endpoints, an object for single-value endpoints. Amounts are **decimal
strings in base units** (apply the token's `dec` to render). KAS values inside `cpState` are in **sompi**
unless noted as SCALE units. `kron-sdk`'s `IndexerClient` unwraps this envelope for you.

### Identifiers

- **`tick`** — the human token ticker (2–12 chars `[a-z0-9]`), case-insensitive in paths.
- **`covenantId`** (a.k.a. covid `A`) — the token covenant's on-chain id. The stable machine identity of a
  token; survives redeploys of *metadata* but is unique per on-chain deploy. **This is the trust anchor** —
  two tokens can't share a covenant-id (KIP-20 genesis non-forgeability), so you can pin a tick to its
  covid and reject impostors, without trusting any indexer.
- **`curveCovenantId`** / **`poolCovenantId`** — the bonding-curve and (post-grad) pool covenant ids.
  `poolCovenantId` is null until graduation.
- **`address`** — a standard `kaspa:`/`kaspatest:` address. URL-encode it in paths.

### Token lifecycle

```
deploy → (trade on curve_cp) → graduate → (swap on amm_pool_cp_v3) → optional LP add/remove
         ^ pre-grad: buy/sell against virtual reserves   ^ post-grad: constant-product AMM
```

`graduated: false` → trade on the curve. `graduated: true` → trade on the pool. A wallet/bot should branch
on this flag.

---

## 4. Read API (indexer)

Base: `https://idx.kron.technology/v1/kcc20`. Use `kron-sdk`'s `IndexerClient` (`src/client/indexerClient.ts`)
for typed access, or hit these directly.

### Discovery / explore

```
GET /v1/kcc20/info
GET /v1/kcc20/markets?kind=curve|pool       # explore-table summary (launch feed / swap table)
GET /v1/kcc20/top-traders                    # global volume leaderboard
```

`info` → `{ result: { tokenTotal, daaScore, synced, network } }`. Poll `synced` before trusting freshness;
`daaScore` is the chain point the view reflects.

### Token metadata + live state — the big one

```
GET /v1/kcc20/token/{tick}
```

Returns `result[0]` with (fields present depend on phase):

```jsonc
{
  "tick": "GHOST", "name": "Ghost", "dec": 8, "max": "1000000000",
  "minted": "...", "holderTotal": 123,
  "covenantId": "…",          // token covid A
  "curveCovenantId": "…",
  "poolCovenantId": "…|null",  // null until graduated
  "graduated": false,
  "tokenReserve": "…",         // curve-owned inventory (sellable supply on the curve)
  "cpState": {
    "realKas": 0,              // sompi raised on the curve (last trade's reserve)
    "tokenReserve": 0,
    "graduated": false,
    // present once graduated:
    "poolTokenReserve": 0,     // pool token inventory
    "poolKas": 0,              // pool KAS reserve (SCALE units; UTXO value = poolKas · SCALE)
    "poolTotalShares": 0,      // LP shares issued
    "poolLpCovid": "…"         // LP-share token covid (covid L)
  },
  // analytics (present when trade history exists):
  "price": 0, "change24h": 0, "volume24h": 0, "volumeTotal": 0,
  "trades24h": 0, "tradesTotal": 0, "tvl": 0, "reserveKas": "…"
}
```

This single call powers a token page, a price command, or a swap quote. **Branch on `graduated`**: pre-grad
use the curve `tokenReserve`/`realKas`; post-grad use the `pool*` fields.

### Balances & holdings (wallet bread-and-butter)

```
GET /v1/kcc20/token/{tick}/address/{address}              # one balance
GET /v1/kcc20/address/{address}/tokenlist                 # every token an address holds
GET /v1/kcc20/token/{tick}/address/{address}/utxos        # the raw token UTXOs (needed to spend)
```

Single balance → `{ result: { tick, balance, dec } }`. `tokenlist` is the call a wallet uses to render a
portfolio in one shot. The `/utxos` call returns the actual UTXOs you must reference when building a
transfer or sell (see §5) — `kron-sdk`'s builders consume this shape directly.

### Holders, history, charts

```
GET /v1/kcc20/token/{tick}/holders
GET /v1/kcc20/token/{tick}/trades?offset=&limit=
GET /v1/kcc20/token/{tick}/ohlc?interval=1h&from=&to=     # candlesticks
GET /v1/kcc20/address/{address}/trades                    # an address's trade history
```

### Pool state (post-graduation swaps)

```
GET /v1/kcc20/token/{tick}/poolhead
```

→ `{ result: { pool: {transactionId, index}, poolToken: {transactionId, index}, reserves: { kasReserve, tokenReserve, totalShares, lpCovid } } }`.

This is the confirmed pool head — the outpoint of the live pool covenant UTXO plus its reserves. A swap
builder needs this to construct the next pool-spending tx. (For high-contention pools, get the *in-flight*
head from the sequencer instead — §6.)

### LP positions

```
GET /v1/kcc20/token/{tick}/lp/{address}/utxos       # the address's LP-share UTXOs (to withdraw)
GET /v1/kcc20/token/{tick}/lp/{address}/earnings    # swap fees earned (KAS), excl. impermanent loss
```

### Live updates (SSE) — don't poll

```
GET /v1/kcc20/stream            # all tokens
GET /v1/kcc20/stream?tick=ghost # one token
```

Server-Sent Events: an `update` event fires per ingested trade / pool change. Subscribe and refetch only
the affected token instead of polling — read load scales with *changes*, not users×poll-rate. A bot
watching prices or a wallet showing a live balance should use this. `IndexerClient.stream()` wraps this
(pass `EventSourceImpl` in Node — see the client's doc comment).

### Token metadata registry (names, images, socials)

```
GET https://api.kron.technology/api/registry/tokens   # { tokens: [...] }
```

The indexer is the source of truth for *amounts and trading state*; the registry holds *display metadata*
the creator signed (name, description, https image, website/x/telegram links, the `cp` deploy record). Join
them by `tick` / `covenantId`. Registry writes are signature-gated to the on-chain creator key —
integrators generally only **read** this (`RegistryClient.tokens()`).

---

## 5. Write API (transactions) — via `kron-sdk`

Every write is a Kaspa transaction the **user's wallet signs**. KRON does not expose a custodial "POST
/buy" — that would defeat the non-custodial design. `kron-sdk` gives you the covenant tx-builders that
produce an unsigned transaction; you get it signed (via a wallet adapter or your own key) and submit it.

```bash
npm install @kronsdk/kron-sdk
```

```ts
import * as kron from '@kronsdk/kron-sdk';
import { loadKaspa } from '@kronsdk/kron-sdk/wasm';
```

The builders (`kron.curveCp.*`, `kron.poolCpV3.*`, `kron.kcc20.*`, `kron.vesting.*`) operate against an
**already-deployed** curve/pool/token: they take the target's current compiled script bytes
(`{script, stateStart}`) and splice in the new state. Read the script bytes from your indexer's live UTXO
data (e.g. a UTXO's `redeemScriptHex` — see §4) rather than compiling them; this package doesn't include a
covenant compiler or the `.sil` sources, and doesn't build the deploy/genesis transactions that create a
*new* curve, pool, or token. See [README.md](../README.md) for a quickstart.

### Covenant entrypoints (what the builders target)

- **`curve_cp.buy` / `sell`** (`kron.curveCp.buildCpBuy` / `buildCpSell`) — pre-graduation trades against
  the virtual-reserve curve. One buyer per tx (single-UTXO curve); batched execution is a separate roadmap
  track.
- **`curve_cp.graduate`** (`kron.curveCp.buildCpGraduate`) — seeds the pool once the raise target is hit
  (anyone can call; usually triggered by the trade that crosses the threshold).
- **`amm_pool_cp_v3.swap`** (`kron.poolCpV3.buildPoolV3SwapKasForToken` / `buildPoolV3SwapTokenForKas`) —
  post-graduation constant-product swap. For hot pools, route via the sequencer (§6) to avoid in-flight
  contention.
- **`amm_pool_cp_v3` add/removeLiquidity** (`kron.poolCp.buildAddLiquidity` / `buildRemoveLiquidity`) —
  voluntary LP deposit/withdraw (conservation shares, not mint/burn).
- **`kcc20.transfer`** (`kron.kcc20.transferSigScript`) — the universal token move. The only way a token
  UTXO changes hands.

### Transfers (wallet "Send")

`transfer` is the KCC-20 primitive for sending tokens between users — **no DEX, no curve involved**. The
covenant authorizes each input by its ownership mode (pubkey sig / P2SH / covenant id / address-presence),
validates each output's state, and enforces conservation on L1.

To send: reference the sender's token UTXOs (from `/address/{address}/utxos`), build a `transfer` that
outputs `[recipientAmount, change]` with the recipient owner identity on the first output, have the wallet
authorize it, submit. Reference builder: `transferSigScript` in `kron.kcc20`; `kron.curveCp.buildSplitToken`
shows the conserving split/transfer shape end to end.

### Signing: the wallet bridge

```ts
const asm = kron.spend.assembleNativeTx(k, { spend, fundingEntries, changeAddress, networkFee });
const pskt = kron.spend.toPsktJson(asm);
const signed = await wallet.signPskt(pskt.txJsonString, pskt.signInputs); // any WalletAdapter implementation
```

See [`docs/WALLETS.md`](WALLETS.md) for the `WalletAdapter` contract and a generic reference implementation
to adapt to a specific wallet's injected provider. For a backend bot holding its own key (no extension
wallet), use `kron.spend.signPsktWithKey(k, txJsonString, signInputs, privKey)` instead.

### Submitting

Signed txs go to the Kaspa node over wRPC (`wss://node.kron.technology`, `testnet-10`) via
`submitTransaction`. Only txs accepted into the virtual (selected-parent) chain mutate indexer state, and
the indexer commits past a confirmation depth — so expect a couple seconds before a write shows up in
reads. Use the SSE stream to know exactly when.

---

## 6. Sequencer (post-graduation pool swaps)

A graduated pool is a **single hot UTXO**: concurrent swaps contend for it. The sequencer is a
**non-custodial batcher** that orders signed swap txs into a valid chain so they don't collide. It never
holds keys — you still sign locally. `kron-sdk`'s `SequencerClient` wraps this.

```
GET  /health
GET  /head?pool={poolP2SH}        # current in-flight head + queue depth
GET  /events?pool={poolP2SH}      # SSE: head changes
POST /submit                      # enqueue a signed swap
```

Swap flow:

1. `sequencer.head(poolP2sh)` → the in-flight head `{ head, depth }` (use this instead of the indexer's
   confirmed `poolhead` when the pool is busy, so you build on the latest unconfirmed state).
2. Build + sign the swap tx against that head.
3. `sequencer.submit({...})` → `{ ok: true, txid, position }` on accept, or `{ ok: false, reason, retry:
   true }` if your `prevHead` is stale (re-fetch head and rebuild).

The sequencer is **pool-only** — it does **not** cover pre-graduation curve buys (those are a separate
batching track). Direct node submission also works for low-contention pools.

---

## 7. Economic constants (reference)

Protocol-level bounds (covenant-enforced) live in `kron.curveConfig`; KRON's own live product defaults are
in `kron.curveConfig.KRON_DEFAULT_FEES` / `KRON_DEFAULT_CURVE_SPLITS`. Your app should respect the *bounds*
to avoid building txs the chain will reject — you're free to choose different fee splits within them.

| Constant | Value | Meaning |
|---|---|---|
| `SCALE` | `1_000_000` sompi (0.01 KAS) | curve price step |
| `MAX_TOKEN` | `1_000_000_000` | supply ceiling (whole tokens) |
| `MAX_FEE_BPS` | `2000` | covenant int64-safety bound on any single fee bps |
| KRON's live defaults | 1.25% pre-grad fee, 5% graduation fee, 0.35% post-grad swap fee, 80/65/50 curve splits | See `KRON_DEFAULT_FEES` — a starting point, not a requirement |

---

## 8. Worked recipes

### Wallet — render a user's portfolio

1. `indexer.tokenlist(address)` → balances per token.
2. For each, `indexer.token(tick)` → `price` to value the holding.
3. Subscribe `indexer.stream(...)` to live-update on trades.

### Wallet — send tokens (the "Send" button)

1. `indexer.tokenUtxos(tick, address)` → sender's token UTXOs.
2. Build a `kcc20.transfer` outputting `[recipientAmount, change]` (builder: `kron.kcc20.transferSigScript`).
3. Wallet signs (presence input at the sender's address); submit to the node.

### TG bot — `/price GHOST`

`indexer.token('ghost')` → render `price`, `change24h`, `volume24h`, market cap (`minted` × `price`), and
`graduated` to show curve-vs-pool status. Optionally `ohlc(...)` for a sparkline.

### TG bot — buy on the curve

1. `indexer.token(tick)` → confirm `graduated: false`, read curve state for a quote (`kron.curve.quoteCpBuy`).
2. Build `curve_cp.buy` (`kron.curveCp.buildCpBuy`), user signs, submit to node.
3. Watch `indexer.stream({tick})` for confirmation, then re-read the balance.

### TG bot / wallet — swap a graduated token

1. `sequencer.head(poolP2sh)` for the in-flight head, or `indexer.poolhead(tick)` if quiet.
2. Build `amm_pool_cp_v3.swap` (`kron.poolCpV3.*`) against that head, user signs.
3. `sequencer.submit({...})` (or submit to the node directly).

---

## 9. Caveats & support

- **Testnet (TN10).** This is the testnet integration surface; mainnet endpoints publish at launch.
- **Wallet signing is a documented contract, not a bundled integration** — see `docs/WALLETS.md` for the
  `WalletAdapter` interface and a generic reference implementation to adapt to your wallet's provider.
- **Confirmation lag.** Reads reflect accepted, confirmation-buried state — expect ~seconds after a write.
  Use SSE rather than tight polling.
- **Single-buyer-per-curve-tx** pre-graduation is a known throughput limit; batched curve execution is a
  roadmap item, not available yet.
