# Building Trades on KRON (end to end)

How to build transfer / buy / sell / swap transactions against KRON's covenants with `@kronsdk/kron-sdk`.
This is the integrator's map of **which call goes where** — the piece that isn't obvious from the SDK
types alone.

## Mental model: two jobs, two places

Every trade splits into two layers that live in different places:

| Job | Where | What it does |
|---|---|---|
| **Compile** the covenant + pick the version | **KRON backend** — `POST https://api.kron.technology/api/native/cp-template` | Turns a token's params into script bytes for the exact version it was deployed under. |
| **Assemble** the transaction | **`@kronsdk/kron-sdk`** | Splices the live on-chain state into the compiled script and builds the tx you sign. |

**The SDK never compiles covenants.** It ships no compiler and no `.sil` sources (by design — see the
note in `src/index.ts`). It only takes a compiled template it's handed and splices bytes into it. So
if you go looking for "where does it compile / handle versions" *in the SDK*, it isn't there — that's
the backend's job. This keeps the SDK trust-minimized: covenant bytes always trace back to the server
and are verifiable against chain, never to a compiler you'd have to trust.

## The one endpoint you fetch templates from

```
POST https://api.kron.technology/api/native/cp-template
{
  ...curveParams,       // spread the WHOLE object verbatim — don't hand-pick fields
  tokenCovid,           // the token's covenant id
  templateVersion       // { schema, silverc } — pins the exact version (omit = current sources)
}
→ { token, pool, curve }   // three compiled templates, each { script, stateStart, params }
```

`curveParams`, `tokenCovid`, and `templateVersion` all come off the token's registry record. Fetch
them with the SDK's `RegistryClient` (or `GET https://api.kron.technology` token metadata).
**Forward `curveParams` verbatim — don't cherry-pick fields.** Besides `creatorFeeOwner`,
`platformFeeOwner`, `vKas`, `graduationKas` and the fee bps, the object can carry extra baked inputs
(e.g. a `vesting` schedule for a token with a locked dev allocation). The compiled bytes — and hence
the covenant **address** — depend on all of them, so dropping one derives the wrong address and your tx
targets a UTXO that doesn't exist.

This is not a style preference — it is how the **dev-fund fee leg** reaches the builders. Every mainnet
token carries `devFundOwner`/`devFundBps`, and the covenant requires a matching P2PK output at a fixed
index (`[5]` on a buy, `[4]` on a sell). Spread the whole record and the builders emit it automatically;
cherry-pick the fields you recognise and you will build transactions the chain rejects. Together with `templateVersion`, spreading the record's `curveParams`
is what guarantees you compile the exact same script (byte-for-byte) that KRON's app and the chain use.
**Templates are static per token — fetch once and cache.** The thing that changes every trade is the
*live state*, below.

## The per-trade shape (same for all flows)

1. **Templates** (cached) — from `cp-template`, as above.
2. **Live state + the covenant UTXO** (fresh, every trade) — from the indexer
   (`https://idx.kron.technology/v1/kcc20`, or the SDK's `IndexerClient`). The covenant UTXO's address
   is derived from its current state, so it **moves after every trade** — you must re-read it:
   - pre-graduation buy/sell → the curve's `tokenReserve` + the curve UTXO (+ its token-inventory UTXO)
   - post-graduation swap → the pool reserves + the pool UTXO (+ its token-side UTXO)
   - transfer → just the token UTXO you're spending (`redeemScriptHex` is already on the
     `GET /v1/kcc20/token/{tick}/address/{address}/utxos` response)
3. **Materialize** — splice the live state into the compiled script:
   - curve: `curveCp.cpAddress(k, curveTpl, state, network)` to derive the address, `curveCp.materializeCpScript(curveTpl, state)` for the bytes
   - pool: `poolCpV3.poolCpV3Address(...)` / `poolCpV3.materializePoolCpV3Script(...)`
4. **Build** — assemble the tx with the builder for the action:
   - `curveCp.buildCpBuy` / `curveCp.buildCpSell` (bonding curve, pre-graduation)
   - `poolCpV3.buildPoolV3SwapKasForToken` / `poolCpV3.buildPoolV3SwapTokenForKas` (AMM pool, post-graduation)
   - the kcc20 transfer builder for a plain token transfer
5. **Sign only the user's inputs** — the covenant inputs are pre-authorized by on-chain rules; the
   wallet signs **only** the user's own P2PK funding inputs (by index) and leaves covenant inputs
   untouched. Via KIP-12 that's `signPskt({ txJsonString, options: { signInputs } })`.
6. **Submit** to the node (`wss://node.kron.technology`, or your own).

Curve vs pool is decided by the token's graduation state — read it from the token record / live state
(a graduated token trades on the pool; a pre-graduation token on the curve).

## What's public and where to look

- **Builders** (the assemble half): `curveCp` and `poolCpV3` namespaces in `@kronsdk/kron-sdk`
  (`src/native/curveCpTx.ts`, `src/native/poolCpV3Tx.ts`).
- **Fetch clients**: `RegistryClient` (token params/metadata) and `IndexerClient` (live state, UTXOs)
  in the SDK.
- **Quote helpers**: `curveCp` quote fns and `poolCpV3.quotePoolV3Buy/Sell` for pricing before you build.
- The README **Quickstart — quote a curve buy** is the smallest working starting point.

## Two gotchas that trip everyone up

- **Fetch the template once, the state every trade.** Caching the template is right; caching the
  covenant *UTXO/address* is wrong — it moves every trade. Re-read live state each time.
- **The indexer lags a beat after a trade.** Right after your tx lands, the indexer may be one poll
  behind on the new state. Retry the state read for a few seconds before failing.

## Coming soon

A higher-level helper (`buildBuy(tokenId, amountKas)` etc.) that does fetch → materialize → build in a
single call, so you don't wire these steps up by hand. Until then, the builders + clients above are
the path.

---

## Partner attribution (integrator program)

If you're in KRON's wallet-integrator program, tag your trades so your volume is credited. Pass your partner
tag as `ref` when you assemble:

```ts
const asm = kron.spend.assembleNativeTx(k, {
  spend, fundingEntries, changeAddress, networkFee,
  ref: 'yourtag',
});
```

That writes `kron:r:<tag>` into the transaction payload. Two things follow from it being *in the transaction*
rather than reported at submit time:

**Route freely.** The tag is captured whether you relay via the sequencer or submit straight to a node. Pick
whichever is faster and more reliable for your users — it no longer affects whether you get paid. (Before
`0.13.0` attribution was recorded only by the sequencer, so a wallet with no contention to sequence submitted
direct and earned nothing.)

**Verify yourself.** Your volume is readable from chain, so you never have to take KRON's word for it:

```
GET https://idx.kron.technology/v1/kcc20/attribution?ref=yourtag
→ { result: [ { ts, market, txid, ref, volume }, … ] }
```

Notes worth knowing:

- The tag must match `^[a-z0-9][a-z0-9_-]{1,31}$` (2–32 chars). An invalid tag is silently dropped to an empty
  payload — validate with `kron.partnerTag.REF_RE` at your configuration boundary, because a dropped tag earns
  nothing and looks identical to untagged traffic.
- Cost is ~2 mass units per byte: a 7-character tag is about **0.000028 KAS**, against a ~0.35 KAS network fee.
- It changes nothing on-chain about the trade itself — no covenant inspects `payload`.
- The tag is unauthenticated: it's an auditable claim, not proof. Settlement is manual review.
- Use the **same tag** as the one on your dashboard account — settlement joins on it.
- Migrating from the sequencer-side `ref` field (pre-0.13.0)? It still records, and KRON merges both
  attribution sources deduped by txid — nothing double-counts. But that path only ever sees
  sequencer-routed trades, so the payload tag is the one that always counts; passing both during the
  transition is safe.
