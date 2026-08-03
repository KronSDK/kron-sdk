# Finding and spending KCC-20 UTXOs

**One rule: a KCC-20 UTXO's native KAS value is not part of its identity and is not predictable. Never select on it. Never assume it when you build a spend. Read it from the UTXO you are about to spend.**

If you take nothing else from this page, take that. The obvious implementation breaks the other rule, it looks correct for months, and it took KRON's own frontend out of service on every token an attacker chose to touch.

## The mistake

A KCC-20 balance lives at a P2SH address derived from its materialized state. So the natural way to find one is:

```ts
// WRONG — do not do this
const hit = entries.find((e) => e.covenantId === tokenCovid && BigInt(e.amount) === 50_000_000n);
```

and the natural way to spend it is to assume the same figure:

```ts
// ALSO WRONG
const input = { transactionId: piece.transactionId, index: piece.index, value: 50_000_000n };
```

`50_000_000n` (0.5 KAS) is the value KRON's builders *emit* covenant token outputs at, sized so KIP-9 storage mass stays sane. It is an emit-side convention. Nothing enforces it on an existing UTXO.

## Why nothing enforces it

`kcc20.sil` enforces token-**amount** conservation (`inSum == outSum`) and says nothing whatsoever about output values. The curve and pool covenants pin only their own KAS continuation and their fee legs. On `buy`, `sell`, `graduate`, `swapKasForToken` and `swapTokenForKas`, the covenant-owned token output's native value is chosen freely by whoever builds the transaction.

That is proven, not assumed. In the KRON repo, [`covenants/native/tools/poc-token-output-value-unpinned.mjs`](https://github.com/) drives the compiled covenants through the Silverscript VM and shows the chain **accepts** that output shaved to 10,000,000 sompi, shaved to 1 sompi, and over-funded by 1 sompi — while the same one-sompi perturbation applied to any output the covenant *does* pin is **rejected**, and `batchBuy` (which pins its token outputs) rejects it in both directions.

So a UTXO you did not create may carry any value at all:

- a stranger can **shave** it — bounded near 0.45 KAS by storage mass, since tiny outputs are charged steeply — or **pad** it, which costs one sompi and has no upper bound at all;
- another implementation can simply use a **different default** and mean nothing by it.

The second one is not hypothetical, and it is the more likely of the two. This SDK defaulted an unset `tokenDust` to a bare `1000n` before `KRN-SDK-DUST` in 0.13.3. A wallet, an aggregator, or another DEX doing the same thing produces perfectly valid UTXOs that a value-matching integration cannot find and a value-assuming builder cannot spend. No attacker is involved.

## What authenticates a balance instead

The address already does it. Owner, identifier type, amount and the minter flag are all inside the script that hashes to the P2SH address, so an entry at the derived address carrying the expected covenant id **is** the balance you meant. Uniqueness is the real guard — if two entries match, something is wrong and you should refuse rather than pick one. The value never authenticated anything.

On chain the covenants re-prove identity independently: `requireOwnTokenReserveInput` pins covenant id, template, pool-ownership and exact amount on the input it spends. You are not the last line of defence here, which is exactly why your selector does not need to be strict about a field that isn't identity.

## Do this instead

```ts
import { covenantSelect } from '@kronsdk/kron-sdk';

const hit = covenantSelect.selectCovenantTokenUtxo(entriesAtDerivedAddress, tokenCovid);
if (!hit) throw new Error('not found or ambiguous');   // fail closed — never fall back to a guess

const inputValue = BigInt(hit.amount);                  // the REAL carrier value
const extra = covenantSelect.carrierShortfall(inputValue);  // 0 when already >= COVENANT_DUST
```

Then:

1. **Feed `inputValue` to the builder** as the input's value. Do not substitute the constant.
2. **Emit at `COVENANT_DUST`.** Re-emitting at 0.5 KAS is what restores the invariant and keeps storage mass reasonable for everyone who touches that UTXO after you.
3. **Add `extra` to your funding selection.** If you emit 0.5 KAS against an input carrying 0.1, you are funding 0.4 KAS out of pocket — bounded, paid once, and it heals the UTXO permanently. If you do not ask for it, your change output goes negative and the transaction is rejected.

An over-funded input needs no adjustment: `carrierShortfall` returns 0 and the surplus lands in your change.

## When an exact value IS correct

Two places, both because the chain pins the value there, so checking it re-verifies a real invariant rather than guessing:

| Case | Why |
|---|---|
| The curve/pool KAS continuation | Covenant-pinned (`tx.outputs[SELF_OUT].value == …`), and it is what discriminates between candidate reserve states. |
| A `batchBuy` buyer output | `curve_cp.sil` requires `== ORDER_TOKEN_DUST`, because each order pre-funds a known escrow. |

For those, pass an explicit `expectedAmount` to `selectCovenantUtxo`. For **every** KCC-20 token balance — curve inventory, pool token reserve, pool LP inventory, or a holder's own presence-owned piece — pass `null`, or just use `selectCovenantTokenUtxo`.

## Checklist

- [ ] No selector compares a KCC-20 UTXO's value to a constant.
- [ ] Every token input's value is read from the chain entry being spent.
- [ ] Funding selection includes `carrierShortfall` for those inputs.
- [ ] Outputs are emitted at `COVENANT_DUST`.
- [ ] Selection fails closed on no match **and** on more than one match.
