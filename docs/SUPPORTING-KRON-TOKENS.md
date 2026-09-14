# Supporting KRON tokens on your DEX or wallet

**For integrators who want to list, hold, or trade a graduated KRON token in their own venue.**

KRON launched before KCC-20 was a formal spec, so its tokens do not follow it byte-for-byte. That does not
block you. A graduated KRON token is an ordinary transferable covenant token, and supporting one is two
steps — **read** its state, and **move** it — with no bonding-curve integration, ever. Full KCC-20
conformance will be offered once the spec is final; until then this is the path, and because every token is
pinned to the template it launched on, nothing you integrate today breaks later.

> **Graduated vs pre-graduation.** A pre-graduation token trades on KRON's bonding curve. Once it hits its
> target it **graduates** into a standard constant-product AMM pool. You only need graduated tokens — check
> `graduated: true` / a non-null `poolCovenantId` on the token record. You never touch the curve.

---

## The two steps

### 1. Read balances + markets — `client.IndexerClient`

Everything you need to display and price a token comes from the public indexer. No auth.

```ts
import { client } from '@kronsdk/kron-sdk';

const idx = new client.IndexerClient('https://idx.kron.technology'); // base URL per KRON's INTEGRATION.md

await idx.markets({ kind: 'pool' });        // every graduated (pool) market — what an aggregator lists
await idx.token('sonar');                   // one token: covenantId, poolCovenantId, graduated, decimals, reserves
await idx.balance('sonar', address);        // an address's balance of a token
await idx.tokenlist(address);               // every token an address holds
await idx.tokenUtxos('sonar', address);     // the individual token UTXOs (what you spend to move it)
```

`token()` returns the token's `covenantId` (the id a wallet tracks) and, once graduated, `poolCovenantId`
(the pair id an aggregator lists). Branch on `graduated`.

### 2. Move tokens — `kcc20.buildKcc20Send`

Moving a token is a plain conserving `transfer`. `buildKcc20Send` builds it: from one or more of an owner's
token UTXOs to a recipient, with change returned. This is a user "Send", a payout from your pool, or a
withdrawal — same primitive. A transfer needs **no backend call** — the token's own UTXOs carry everything
(`client.fetchCpTemplates` is only for the curve/pool *trade* builders, not for a transfer).

```ts
import { kcc20 } from '@kronsdk/kron-sdk';
// `k` is the Kaspa WASM (via '@kronsdk/kron-sdk/wasm'); see the README quickstart for load/sign/submit.
// hexToBytes = any hex → Uint8Array.

const info  = await idx.token('sonar');                       // info.covenantId is the token covid
const utxos = await idx.tokenUtxos('sonar', poolAddress);     // TokenUtxo[]: { outpoint, amount, redeemScriptHex, ... }

// The redeem carries the template AND the state (amount, owner, mode) — decode it, no template fetch needed.
const decoded  = utxos.map((u) => ({ u, ...kcc20.decodeKcc20Redeem(hexToBytes(u.redeemScriptHex)) }));
const template = decoded[0].template;

const senderTokens = decoded.map(({ u, state }) => ({
  transactionId: u.outpoint.transactionId,
  index: u.outpoint.index,
  value: chainKasValueOf(u.outpoint),  // ← the UTXO's KAS carrier value, read from CHAIN, not the indexer (see gotcha below)
  state,
}));

const spend = kcc20.buildKcc20Send(
  k, template, senderTokens,
  recipientPubkey32,          // who receives the payout / withdrawal
  amount,                     // token amount to send (change auto-returned)
  senderTokens.length,        // presenceWitnessIdx: the P2PK input authorizing, placed after the token inputs
  info.covenantId,            // token covid — required so every output carries its KIP-20 binding
);
// then assemble → sign the P2PK input → submit. Full assemble/sign/submit flow: docs/BUILDING-TRADES.md.
```

That is the whole surface. Reading is unauthenticated HTTP; moving is one builder call — plus reading each
UTXO's KAS carrier value from chain, which is the one thing that trips people up (next section).

---

## Running your own pool

There are two ways to hold a graduated KRON token in a pool, and they are very different amounts of work.

**A. Custodial / standard pool — this is steps 1 + 2, nothing more.**
Your pool holds the tokens at an address or key you control (address/presence ownership). A **deposit** is a
transfer the *user's* wallet builds to your address — you just detect the incoming UTXO with the indexer. A
**payout / swap / withdrawal** is a `buildKcc20Send` from your pool's UTXOs. Your AMM math runs on top; the
token is just an asset you move. Most integrations want exactly this, and it is fully supported today.

**B. Trustless on-chain AMM covenant — possible, but bespoke today.**
If you want the *pool itself* to be a covenant that owns the token, KRON's token supports covenant-id
ownership (`kcc20.covenantIdOwned(covid, amount)` + `kcc20.transferSigScript`), so a third-party covenant
can hold and co-spend it. But your pool covenant has to speak KRON's exact transfer + ownership ABI, which is
integrator-specific work. **This is the case KCC-20 conformance makes plug-and-play** — once KRON ships a
conforming token generation, your existing KCC-20 pool tooling will just work. Until then, prefer (A) unless
you specifically need an on-chain-enforced pool.

---

## Must-read: covenant UTXOs are not address balances

A KCC-20 UTXO's native KAS value **is not part of its identity and is not predictable** — no covenant pins
it, and different builders have used different defaults. If you match or assume a fixed carrier value you
will fail to find, or fail to spend, perfectly valid UTXOs. Select by lineage (covid), read the value from
the entry you actually spend, and size funding with `covenantSelect.carrierShortfall`. This is the single
most common integration bug.

→ **[docs/INTEGRATING-KCC20-UTXOS.md](INTEGRATING-KCC20-UTXOS.md)** — read it before you build the transfer.

Also pin your SDK to a current version: several pre-0.13.3 releases built shapes that live covenants reject
(see the version warnings at the top of the README).

---

## Conformance is coming — and nothing you build here is throwaway

KRON will offer **KCC-20-conforming tokens once the spec is final.** That will arrive as a new, opt-in token
generation; existing tokens stay pinned to their current templates and keep working exactly as they do now.
So the integration above stays valid, and if you later switch to the conforming path it is additive, not a
migration.

## See also

- **[docs/BUILDING-TRADES.md](BUILDING-TRADES.md)** — if you also want to trade on KRON's *own* curve/pool
  (buy / sell / swap), not just move tokens into your own venue.
- **[docs/INTEGRATION.md](INTEGRATION.md)** — the full endpoint + client surface, data shapes, base URLs.
