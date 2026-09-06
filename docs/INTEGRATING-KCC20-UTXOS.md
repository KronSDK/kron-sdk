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

`kcc20.sil` enforces token-**amount** conservation (`inSum == outSum`) and says nothing whatsoever about output values — on every schema, current included. On the schemas most live tokens run, the curve and pool covenants pin only their own KAS continuation and their fee legs, so on `buy`, `sell`, `graduate`, `swapKasForToken` and `swapTokenForKas` the covenant-owned token output's native value is chosen freely by whoever builds the transaction.

From the **value-continuation schema** onward those covenants additionally enforce `out.value >= in.value` on that output. That stops shaving — but it deliberately still permits **padding**, because the check is relative rather than an absolute dust constant (baking a constant into an immutable redeem would brick every already-launched token if the dust size ever changed). So the value is still not something you may assume in either direction.

That is proven, not assumed. In the KRON repo, `covenants/native/tools/poc-token-output-value-continuation.mjs` drives the compiled covenants through the Silverscript VM against the archived pre-fix sources and the current ones side by side: pre-fix the chain **accepts** that output shaved to 10,000,000 sompi, shaved to 1 sompi, and over-funded by 1 sompi; on current sources every shave is **rejected** at its own continuation check while over-funding is still accepted. The same one-sompi perturbation on any output the covenant *does* pin is rejected on both, and `batchBuy` — which pins its token outputs absolutely — rejects it in both directions.

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
2. **Emit at `continuationValue(COVENANT_DUST, inputValue)` for a covenant-owned continuation** — the curve inventory, pool token reserve or pool L inventory. From the value-continuation schema onward the covenants enforce `out.value >= in.value` there, so a bare constant against a padded reserve is rejected by consensus, and because that output is the token's only reserve the rejection wedges the token permanently. Every other output emits plain `COVENANT_DUST`. Applying `continuationValue` unconditionally is safe on older schemas too — they constrain no output value, and carrying the larger value forward is what an honest spender does anyway. Do not branch on schema.
3. **Add `extra` to your funding selection.** If you emit 0.5 KAS against an input carrying 0.1, you are funding 0.4 KAS out of pocket — bounded, paid once, and it heals the UTXO permanently. If you do not ask for it, your change output goes negative and the transaction is rejected.

An over-funded input needs no adjustment: `carrierShortfall` returns 0 and the surplus lands in your change.

## When an exact value IS correct

Two places, both because the chain pins the value there, so checking it re-verifies a real invariant rather than guessing:

| Case | Why |
|---|---|
| The curve/pool KAS continuation | Covenant-pinned (`tx.outputs[SELF_OUT].value == …`), and it is what discriminates between candidate reserve states. |
| A `batchBuy` buyer output | `curve_cp.sil` requires `== ORDER_TOKEN_DUST`, because each order pre-funds a known escrow. |

For those, pass an explicit `expectedAmount` to `selectCovenantUtxo`. For **every** KCC-20 token balance — curve inventory, pool token reserve, pool LP inventory, or a holder's own presence-owned piece — pass `null`, or just use `selectCovenantTokenUtxo`.

## The witness index is capped at 127, not 255

Having found the UTXO, you have to say what authorizes spending it. Each token input names the co-present signed P2PK input that stands for its owner — `presenceWitnessIdx`, encoded into the sigscript's `byte[] witnesses`. That index must be an **integer in `[0, 127]`**, exported as `kcc20.MAX_WITNESS_IDX`.

The ceiling is 127 rather than 255 because the covenant reads each entry back as a script number, and the bytes `0x80..0xff` decode on chain as **negative**. An index of 128 or above cannot authorize an input on any schema — there is no version of this where the high half works.

`0.18.0` and earlier truncated an out-of-range index to a single byte and said nothing, so the index you passed silently became a *different* one: `256` became `0`, which on a covenant spend points at the covenant input — an input that carries no signature at all. `0.18.1` throws at build time instead.

Tell that failure apart from an ABI mismatch when you triage it. On schemas without the HLK-L11 bounds check, a truncated index surfaced as **`pick at an invalid location`** — the same node string an ABI-arity mismatch produces, from an entirely unrelated cause. Schemas carrying the check fail as `script ran, but verification failed`. So if you see `pick at an invalid location`, check the witness index you passed before you go rereading discriminator flags; the build-time throw exists to keep the two from being confused again.

## Checklist

- [ ] No selector compares a KCC-20 UTXO's value to a constant.
- [ ] Every token input's value is read from the chain entry being spent.
- [ ] Funding selection includes `carrierShortfall` for those inputs.
- [ ] Covenant-owned continuation outputs are emitted at `continuationValue(COVENANT_DUST, inputValue)`;
      every other output at plain `COVENANT_DUST`.
- [ ] Selection fails closed on no match **and** on more than one match.
- [ ] Every `presenceWitnessIdx` is an integer in `[0, kcc20.MAX_WITNESS_IDX]` (127, not 255) and points at
      a signed P2PK input, never at a covenant input.
- [ ] `pick at an invalid location` is triaged as a witness index *or* an ABI-arity mismatch before either
      is assumed.
