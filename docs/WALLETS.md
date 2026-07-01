# Wallet integration guide

KRON is non-custodial: every state-changing action is a Kaspa transaction that **the user's own wallet
signs**. This package builds the *unsigned* transaction; your wallet supplies the signature. This document
is for wallet developers who want to become a signing option for KRON.

## The contract: `WalletAdapter`

```ts
import type { WalletAdapter } from '@kronsdk/kron-sdk';
```

See [`src/wallet/types.ts`](../src/wallet/types.ts) for the full interface. The short version: a wallet
needs to expose

- `connect()` / `getAddress()` / `disconnect()` — standard session lifecycle.
- `signPskt(txJsonString, signInputs)` — **the important one.** Given a transaction in Kaspa "Safe JSON"
  form and a list of `{index, sighashType}` describing which inputs are the user's own P2PK funding
  inputs, sign **only those inputs** and return the re-serialized signed transaction. The transaction's
  *covenant* inputs (the curve, the pool, a token UTXO owned by covenant-id or by "presence") are never
  sent to the wallet for signing — their spend is authorized by the covenant's own on-chain rules, or by a
  co-present signed P2PK input at the owner's address. This is what makes KRON work with a wallet that has
  never heard of KRON: the wallet only ever signs a plain P2PK input, the same primitive it already
  supports for a normal send.
- `getXOnlyPublicKey()` / `signMessage()` — optional but recommended. Used for setting a token's
  creator-fee-owner at deploy time, and for authenticating signed writes to KRON's metadata registry
  (display name/image/links) via the [KIP-5](https://github.com/kaspanet/kips/blob/master/kip-0005.md)
  message-signing scheme.

**Why this shape and not something else:** it's not an official Kaspa standard — none exists yet for
dApp↔wallet signing (see "Ecosystem context" below). It's a working pattern proven functional on TN10:
build the transaction, hand the wallet only the specific inputs that need its signature, broadcast. Any
wallet that can sign a Kaspa PSKT-shaped transaction for specific inputs can implement this interface.

## Reference implementation

[`src/wallet/example.ts`](../src/wallet/example.ts) (`ExampleWalletAdapter`) is a generic, illustrative
implementation — **not tied to any specific wallet product**. It shows the shape a browser-extension wallet
provider typically takes (an injected `window.<name>` object with `requestAccounts`/`signPskt`-style
methods) and how to wire that into the `WalletAdapter` contract. Copy it, point it at your own injected
provider's actual global name and method shapes, and adjust the method bodies to match — the interface only
constrains what you expose, not how you get there.

Capability-flag pattern: not every wallet implements every optional method (`signPskt`, `getXOnlyPublicKey`,
`signMessage`, `reconnect`). Report this honestly via `capabilities()` — a method you haven't implemented
yet should throw a clear, typed error (see `WalletCapabilityError`), never silently no-op or produce a
best-guess signature. A wrong-but-silent signature over the wrong sighash is a fund-safety bug, not just an
API mismatch.

## Writing your own adapter

1. Implement `WalletAdapter` (see `src/wallet/types.ts`), using `example.ts` as a starting point.
2. Be honest in `capabilities()` — omit a method entirely if it's genuinely optional (like `reconnect`), or
   throw `WalletCapabilityError` if it's not yet implemented. Never guess at a signing shape you haven't
   confirmed; a plausible-looking but wrong sighash mapping produces a transaction that's silently signed
   incorrectly.
3. Test the `signPskt` path specifically against a testnet transaction with **both** a covenant input and a
   user P2PK input (e.g. a KRON curve buy) — signing a plain send is not sufficient coverage, since it
   never exercises the "only sign these specific inputs, leave the rest alone" requirement that makes
   covenant transactions work.

## Ecosystem context

There is currently **no official Kaspa standard** for dApp↔wallet transaction signing (no equivalent of
Ethereum's EIP-1193/WalletConnect) or for multi-wallet auto-discovery (no equivalent of EIP-6963). The one
piece of the signing story that *is* an official, accepted [Kaspa Improvement
Proposal](https://github.com/kaspanet/kips) is message signing —
[KIP-5](https://github.com/kaspanet/kips/blob/master/kip-0005.md) specifies
`schnorr_sign(blake2b(message, digest_size=32, key='PersonalMessageSigningHash'), privateKey)`. This
package's `signMessage` flow goes through the Kaspa WASM SDK's own `signMessage`/`verifyMessage` (which
implements KIP-5), so it should be compliant by construction — the SDK's own round-trip is exercised in
`scripts/smoke-test-node-wasm.mjs` step 5.

The `WalletAdapter` interface itself is **not** an official standard — it's a working pattern this package
promotes because none exists yet. If you'd find a real cross-wallet standard useful, that's a longer-horizon
conversation worth having with Kaspa core; this package is deliberately scoped to "make integration easy
today," not to that standardization effort.
