# KRON integration guide

> Mainnet integration surface. KRON is live on Kaspa **mainnet**; there is no KRON testnet (TN10 was
> retired at the mainnet migration). Endpoints and shapes below are stable to build against.

This guide is for anyone integrating KRON — wallets, Telegram bots, explorers, analytics, trading UIs. The
running examples are framed around a **wallet extension** and a **Telegram bot** because those are the two
most common shapes, but every primitive here is general-purpose.

> **Building transfer / buy / sell / swap transactions?** See **[BUILDING-TRADES.md](BUILDING-TRADES.md)**
> for the end-to-end flow — which call goes to the backend (compile) vs. the SDK (assemble), and the
> per-trade sequence.

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
  funds**, only for convenience of querying. (Contrast with rollup-style token standards, where an
  off-chain indexer *is* the ledger.)
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

## 2. Network & endpoints (mainnet)

All services are live on Kaspa **mainnet**.

| Service | Base URL | Purpose |
|---|---|---|
| **Indexer** (KCC-20 API) | `https://idx.kron.technology` | Balances, metadata, prices, holders, pool state, history, SSE. Path prefix `/v1/kcc20`. |
| **Backend** (registry) | `https://api.kron.technology` | Token metadata registry (name/image/links/socials), LP positions, comments, alerts. |
| **Sequencer** | `https://seq.kron.technology` | Non-custodial batcher for hot markets: **post-graduation pool swaps** and **pre-graduation curve buys/sells** (`/curve/*`). |
| **Node** (wRPC) | `wss://node.kron.technology` | Kaspa wRPC (borsh) over wss — UTXO set, submit tx. `mainnet`. |
| **Frontend** | `https://kron.technology` | Reference UI (useful for cross-checking behavior). |

`network` everywhere = `mainnet`. There is no KRON testnet — TN10 was retired at the mainnet migration —
so validate write paths with one small real trade (see §9). The `kron-sdk` REST clients take `baseUrl` as
an explicit constructor argument (no baked-in default), so pointing at a different deployment is a
one-line change, not a version bump.

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
- **`address`** — a standard `kaspa:` address. URL-encode it in paths.

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
GET /v1/kcc20/address/{address}/trades?offset=&limit=     # an address's trade history (all tokens)
GET /v1/kcc20/token/{tick}/address/{address}/trades?offset=&limit=  # one address's history on ONE token
```

### Pool state (post-graduation swaps)

```
GET /v1/kcc20/token/{tick}/poolhead
```

→ `{ result: { pool: {transactionId, index}, poolToken: {transactionId, index}, reserves: { kasReserve, tokenReserve, totalShares, lpCovid } } }`.

This is the confirmed pool head — the outpoint of the live pool covenant UTXO plus its reserves. A swap
builder needs this to construct the next pool-spending tx. (For high-contention pools, get the *in-flight*
head from the sequencer instead — §6.)

### Curve state (pre-graduation trades)

There is **no indexer `curvehead` endpoint** — unlike the pool, the indexer doesn't hand you a
ready-to-spend curve outpoint. This is a common integration trap, so read this before wiring up
curve buys/sells:

- **Use `sequencer.curveHead(curveCovid)` for the live outpoint** (§6, `SequencerClient.curveHead`).
  This is the correct way to fetch curve state right before building a trade — it returns the
  current spendable outpoint + reserves directly, including a still-unconfirmed prior trade, so
  you build on the real tip instead of racing the indexer. Do this even on a quiet curve; it's
  cheap and avoids the failure mode below entirely.
- **Why going straight to the indexer is racy:** the curve covenant's on-chain address is
  state-dependent (its committed `tokenReserve` is spliced into the redeem script), so the curve
  moves to a *new address every trade*. If you derive that address yourself from
  `indexer.token(tick)`'s `cpState.tokenReserve` right after a trade lands, the indexer can lag
  its own poll interval before that field updates — you'll compute the address the curve *was*
  at, not the one it's at now, and the UTXO lookup comes back empty. On an actively-traded curve
  this produces exactly this failure: a buy fails a few times a few seconds apart with "no curve
  UTXO found / state moved", then a retry succeeds once the indexer catches up.
- **If you must fall back to the indexer** (sequencer unreachable), retry the derive-address →
  look-up-UTXO step rather than failing on the first miss. KRON's own web app retries **5 times,
  1.5s apart (~6s total)** before giving up — treat that as the minimum backoff, not a starting
  point to shrink.

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

### Token list — for wallets / explorers / aggregators

```
GET https://api.kron.technology/api/registry/tokenlist          # tokenlists.org-shaped, verified-only
GET https://api.kron.technology/api/registry/tokenlist?all=1     # also include unverified tokens
```

One [tokenlists.org](https://tokenlists.org)-shaped document listing KRON tokens so standard tooling can
ingest "what tokens exist and how do I identify them" from a single URL. `RegistryClient.tokenlist()`
returns it typed (`TokenList` / `TokenListEntry`). Each entry's `covenantId` (covid `A`) is the canonical
**token** id (the add-to-wallet / asset id); `extensions.poolCovenantId` (covid `P`) is the **pool/pair**
id and is non-null only post-graduation (that's what DEX screeners key on) — the two are not
interchangeable. The default list is **chain-verified only** (anti-phishing); `?all=1` adds unverified
entries tagged `extensions.chainVerified:false`.

**The list is not platform-signed — verify each entry against the chain yourself.** Each entry carries a
`genesisTxid` proof pointer; `verify.verifyTokenListEntry` confirms the entry's `covenantId` is genuinely
created on that tx (present as a `covenant_id` on one of its outputs), so a spoofed entry can't pass:

```ts
import { client, verify } from '@kronsdk/kron-sdk';

const reg = new client.RegistryClient('https://api.kron.technology');
const list = await reg.tokenlist();                 // { name, version, network, tokens: [...] }

// Inject a tx fetcher — the SDK ships no Kaspa node client. kaspaRestFetchTx wraps the common REST shape.
const fetchTx = verify.kaspaRestFetchTx('https://api.kaspa.org');
const safe = [];
for (const entry of list.tokens) {
  const r = await verify.verifyTokenListEntry(entry, fetchTx);   // { ok, covenantIdPresent, reason? }
  if (r.ok) safe.push(entry);                                    // trust only what re-checks against chain
}
```

`fetchTx` is any `(txid) => Promise<tx>` — use `kaspaRestFetchTx(base)`, a node RPC, or a proxy. This does
**not** re-derive the curve script from params (the SDK has no covenant compiler); the covenant-id-on-genesis
check is the achievable, sufficient anti-spoof proof. For a full cryptographic re-derivation, feed the init
tx's outpoint + authorized outputs to `genesis.genesisCovenantId`.

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
  voluntary LP deposit/withdraw (conservation shares, not mint/burn). **`buildAddLiquidity` requires
  `opts.lpBindVerified` since 0.17.0 and fails closed** — call `IndexerClient.assertLpBindSafe(tick)` and pass
  the verdict; an absent or unverifiable value throws instead of building. `buildRemoveLiquidity` is never
  gated. **`buildRemoveLiquidity` requires
  `opts.lpInventory` — the pool's L-inventory UTXO — whenever `poolTpl.canonicalInventoryRequired` is true,
  which every live pool sets (≥ 0.13.2; earlier releases always built a shape every current pool rejects).
  Fetch it the same way you already do for `buildAddLiquidity`.
- **`kcc20.transfer`** (`kron.kcc20.transferSigScript`) — the universal token move. The only way a token
  UTXO changes hands.

### Transfers (wallet "Send")

`transfer` is the KCC-20 primitive for sending tokens between users — **no DEX, no curve involved**. The
covenant authorizes each input by its ownership mode (pubkey sig / P2SH / covenant id / address-presence),
validates each output's state, and enforces conservation on L1.

To send: reference the sender's token UTXOs (from `/address/{address}/utxos`), decode each UTXO's
`redeemScriptHex` with `kron.kcc20.decodeKcc20Redeem` (→ the splice template + current state), build the
spend with `kron.kcc20.buildKcc20Send` (outputs `[recipientAmount, change]`, presence-authorized by the
sender's co-present P2PK funding input), assemble + sign + submit.
**Runnable end-to-end example: [`scripts/example-kcc20-send.mjs`](../scripts/example-kcc20-send.mjs).**
Lower-level pieces if you need custom shapes: `transferSigScript` (the raw signature script),
`kron.curveCp.buildSplitToken` / `buildConsolidate` (same-owner split/merge).

### Covenant transactions are v1 (bindings + compute budgets) — REQUIRED

A covenant spend only validates on-chain as a KIP-20 **version-1** transaction:

- **`CovenantBinding` on every covenant output.** Each token/curve/pool output must declare
  `{ authorizingInput, covenantId }` to enter the covenant-id group. Without it, the covenant's
  `OpCovOutputCount(id)` sees **zero** outputs and the spend is rejected with
  `script ran, but verification failed` — the single most common integration failure. The builders set
  the binding when you pass the covenant id (e.g. `buildKcc20Send`'s `tokenCovid` — the `covenantId`
  from `indexer.token(tick)`); for custom spends set `spend.outputs[i].binding = { covid, authorizingInput }`
  before assembling.
- **`computeBudget` on every input** (v1 replaces `sigOpCount`): P2PK funding ≈ 10, a kcc20 transfer
  input ≈ 500, a curve/pool input ≈ 2000. `assembleNativeTx` applies role-based defaults.
- **Fees must cover the compute budget** (grams = budget × 100) on top of byte/storage mass — a flat
  legacy fee (e.g. 5000 sompi) is too low. Size with `kron.spend.estimateNativeFee`.
- **Covenant outputs carry ≥ 0.5 KAS** (`kron.spend.COVENANT_DUST`) for KIP-9 storage mass. That is an
  EMIT-side convention — nothing requires an EXISTING token UTXO to hold it, so read each input's value from
  chain rather than assuming. A covenant-owned CONTINUATION output (curve inventory, pool token reserve, pool
  L inventory) must be emitted at `covenantSelect.continuationValue(COVENANT_DUST, inputValue)`: from the
  value-continuation covenant onward the chain enforces `out.value >= in.value` there, so a bare constant
  against a padded reserve is rejected. Add `covenantSelect.carrierShortfall(inputValue)` to your funding.
  Full rationale: [INTEGRATING-KCC20-UTXOS.md](INTEGRATING-KCC20-UTXOS.md).

`assembleNativeTx` handles all of this (SDK ≥ 0.5.0; earlier versions built v0 transactions without
bindings, which the chain always rejects — upgrade).

### Signing: the wallet bridge

```ts
// 1. Assemble with a GUESS fee, purely to get something the right size to measure.
let asm = kron.spend.assembleNativeTx(k, { spend, fundingEntries, changeAddress, networkFee: 10_000n });
// 2. Size the real fee against that assembly.
const networkFee = kron.spend.estimateNativeFee(k, NETWORK_ID, asm, 100);
// 3. RE-ASSEMBLE with the real fee — this changes the change output's value, which changes every
//    funding input's sighash. Discard the first `asm`; only this second one may be signed.
asm = kron.spend.assembleNativeTx(k, { spend, fundingEntries, changeAddress, networkFee });
const pskt = kron.spend.toPsktJson(asm);
const signed = await wallet.signPskt(pskt.txJsonString, pskt.signInputs); // any WalletAdapter implementation
```

**Never sign or submit the step-1 (guess-fee) `asm`.** The sighash commits to every output's value,
including the KAS change output — so re-assembling with the real fee from `estimateNativeFee` changes that
output and invalidates any signature computed against the earlier assembly. Signing the wrong one surfaces
at broadcast as `failed to verify the signature script: signature invalid: malformed signature`, which reads
like a builder/covenant bug but is actually just an out-of-order call — the transaction was structurally
fine. `estimateNativeFee` sizes a fee for a transaction; it does not size *and* rebuild it for you. See
[`scripts/example-kcc20-send.mjs`](../scripts/example-kcc20-send.mjs) for a complete runnable example of the
assemble → estimate → re-assemble → sign sequence.

(The sighash also commits to the output covenant bindings, so bindings are attached at assembly, before
signing — a signed tx can't be re-bound.)

See [`docs/WALLETS.md`](WALLETS.md) for the `WalletAdapter` contract and a generic reference implementation
to adapt to a specific wallet's injected provider. For a backend bot holding its own key (no extension
wallet), use `kron.spend.signPsktWithKey(k, txJsonString, signInputs, privKey)` instead.

### Submitting

Signed txs go to the Kaspa node over wRPC (`wss://node.kron.technology`, `mainnet`) via
`submitTransaction`. Only txs accepted into the virtual (selected-parent) chain mutate indexer state, and
the indexer commits past a confirmation depth — so expect a couple seconds before a write shows up in
reads. Use the SSE stream to know exactly when.

---

## 6. Sequencer (hot pools and hot curves)

A graduated pool is a **single hot UTXO**: concurrent swaps contend for it. The same is true of a
pre-graduation bonding curve during a launch burst. The sequencer is a **non-custodial batcher** that
orders signed txs into a valid chain so they don't collide. It never holds keys — you still sign
locally. `kron-sdk`'s `SequencerClient` wraps both markets; `health()` reports which the deployment
supports (`markets: ['pool','curve']`).

```
GET  /health
GET  /head?pool={tick}            # pool: current in-flight head + queue depth (param is the token TICK)
GET  /events?pool={tick}          # pool: SSE head changes
POST /submit                      # pool: enqueue a signed swap
GET  /status?pool={tick}&txid={txid}  # pool: this tx's lifecycle in the sequencer's view
GET  /curve/head?covid={covid}    # curve: current in-flight head + queue depth
POST /curve/submit                # curve: enqueue a signed buy/sell
```

The pool endpoints are keyed by the **token tick** (e.g. `pepe`), never the pool P2SH — the pool's
address moves with its state (`lpCovid` bind, `totalShares` changes), so the tick is the stable key.
Earlier releases of this doc and `SequencerClient` said `poolP2SH`; a P2SH has never matched.

`/status` returns `{ ok, known, state, txid }` with `state` one of `broadcasting`, `accepted`,
`rejected`, `broadcast-ambiguous`, `confirmed`, `dropped` (chain evicted), or `unknown` (never seen,
or aged out). On-chain acceptance remains the settlement truth. After a submit-then-timeout, check
`/status` before re-submitting a REBUILT tx directly — `broadcast-ambiguous` means the original may
already be in the mempool, and a rebuilt tx (new txid) would double-spend your own funding inputs.
Prefer the `/events` SSE stream over polling for head changes.

Pool swap flow:

1. `sequencer.head(tick)` → the in-flight head `{ head, depth }` (use this instead of the indexer's
   confirmed `poolhead` when the pool is busy, so you build on the latest unconfirmed state).
2. Build + sign the swap tx against that head.
3. `sequencer.submit({...})` → `{ ok: true, txid, position }` on accept, or `{ ok: false, reason, retry:
   true }` if your `prevHead` is stale (re-fetch head and rebuild).

Curve trade flow (pre-graduation buys/sells) is the same shape, keyed by the token's **curve covenant
id** instead of the tick:

1. `sequencer.curveHead(curveCovid)` → `{ head, depth }`. `head: null` means no chain is in flight —
   build against the confirmed curve state from the node/indexer instead.
2. Build + sign the buy/sell against that head (`prevHead.poolOutpoint` = the curve UTXO,
   `prevHead.poolTokenOutpoint` = the curve-owned inventory; reserves are `realKas`/`tokenReserve`/`vKas`).
3. `sequencer.curveSubmit({ covid, signedTx, prevHead, declaredReserves })` → same result shape,
   including the stale-`prevHead` retry gate.

### Partner attribution

Wallet-integrator partners ([kron.technology/wallets](https://kron.technology/wallets)) tag their trades
**in the transaction itself**: pass your assigned partner tag as the optional `ref` when you assemble
(SDK ≥ 0.13.0):

```ts
const asm = kron.spend.assembleNativeTx(k, { spend, fundingEntries, changeAddress, networkFee, ref: 'yourtag' });
```

That writes `kron:r:<tag>` into the transaction payload, so the trade is credited **whichever route it
takes** — sequencer or direct-to-node. Route for latency and reliability; it no longer affects whether you
get paid. Your credited volume is auditable straight from chain, without trusting KRON's books:

```
GET https://idx.kron.technology/v1/kcc20/attribution?ref=yourtag
→ { result: [ { ts, market, txid, ref, volume }, … ] }
```

The tag is 2–32 chars of `a-z 0-9 - _` (`kron.partnerTag.REF_RE`). Validate it at your configuration
boundary — `assembleNativeTx` silently drops an invalid tag to an empty payload (an untaggable trade must
still build), and a dropped tag earns nothing. Cost, security model, and settlement details:
[BUILDING-TRADES.md § Partner attribution](BUILDING-TRADES.md#partner-attribution-integrator-program).

**Legacy sequencer-side `ref` (pre-0.13.0).** The optional `ref` field on `submit()`/`curveSubmit()` still
works — the sequencer records tagged relays, and KRON merges both attribution sources deduped by txid. But
it structurally sees only sequencer-routed trades (that blind spot is why the payload tag exists), so treat
it as legacy and move to the payload tag. A malformed sequencer `ref` is rejected with `400`; the deployed
sequencer advertises the field via `health().attribution`.

In both markets, direct node submission also works under low contention — the sequencer is a
convenience for hot markets, and any sequencer-side gate should fall back to direct submission.

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
| KRON's live defaults | 1.25% curve trade (platform 0.90 / creator 0.25 / dev fund 0.10), 5% graduation, 1.00% post-grad swap (platform 0.70 / LP 0.20 / creator 0.10) | Read them per-token from the registry's `curveParams` — fees are **baked at launch** and differ between tokens. Never hardcode. |

---

## 8. Worked recipes

### Wallet — render a user's portfolio

1. `indexer.tokenlist(address)` → balances per token.
2. For each, `indexer.token(tick)` → `price` to value the holding.
3. Subscribe `indexer.stream(...)` to live-update on trades.

### Wallet — send tokens (the "Send" button)

1. `indexer.token(tick)` → `covenantId` (the outputs' binding target); `indexer.tokenUtxos(tick, address)`
   → sender's token UTXOs (`redeemScriptHex` each).
2. `kron.kcc20.decodeKcc20Redeem(redeem)` → template + state; `kron.kcc20.buildKcc20Send(...)` →
   the `[recipientAmount, change]` spend with covenant bindings.
3. `assembleNativeTx` (v1 + budgets) + `estimateNativeFee`; wallet signs the funding inputs (the
   presence input at the sender's address); submit to the node.

Complete runnable version: [`scripts/example-kcc20-send.mjs`](../scripts/example-kcc20-send.mjs).

### TG bot — `/price GHOST`

`indexer.token('ghost')` → render `price`, `change24h`, `volume24h`, market cap (`minted` × `price`), and
`graduated` to show curve-vs-pool status. Optionally `ohlc(...)` for a sparkline.

### TG bot — buy on the curve

1. `indexer.token(tick)` → confirm `graduated: false`, read curve state for a quote (`kron.curve.quoteCpBuy`).
2. `sequencer.curveHead(curveCovid)` for the live spendable outpoint — see §4 "Curve state" and
   §6. Don't derive the curve's address yourself from indexer state and search for its UTXO; that
   path races the indexer and intermittently fails on busy curves.
3. Build `curve_cp.buy` (`kron.curveCp.buildCpBuy`) against that head, user signs, submit
   (`sequencer.curveSubmit`, or direct to the node).
4. Watch `indexer.stream({tick})` for confirmation, then re-read the balance.

### TG bot / wallet — swap a graduated token

1. `sequencer.head(tick)` for the in-flight head, or `indexer.poolhead(tick)` if quiet.
2. Build `amm_pool_cp_v3.swap` (`kron.poolCpV3.*`) against that head, user signs.
3. `sequencer.submit({...})` (or submit to the node directly).

---

## 9. Caveats & support

- **Mainnet only — no testnet.** KRON runs on Kaspa mainnet; TN10 was retired at the mainnet migration.
  Reads and transaction *building* are free (public endpoints, no funds needed) — validate the signed
  write path with one small real trade before shipping.
- **Wallet signing is a documented contract, not a bundled integration** — see `docs/WALLETS.md` for the
  `WalletAdapter` interface and a generic reference implementation to adapt to your wallet's provider.
- **Confirmation lag.** Reads reflect accepted, confirmation-buried state — expect ~seconds after a write.
  Use SSE rather than tight polling.
- **Single-buyer-per-curve-tx** pre-graduation is a known throughput limit; batched curve execution is a
  roadmap item, not available yet.
