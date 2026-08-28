// Shape the KRON backend's `POST /api/native/cp-template` response into the typed template objects the
// builders take (`kcc20.Kcc20Template`, `poolCp.PoolCpTemplate`, `curveCp.CpTemplate`) — INCLUDING the
// dual-ABI discriminators, hydrated from the COMPILER'S params echo.
//
// WHY THIS EXISTS (HLK-L04 / HLK-L07 / HLK-L12). KRON's covenant schemas are pinned per token, and the
// current schema changed the buy/sell and pool entrypoint ABIs: recipient-bound schemas take two appended
// witness args on every value-releasing entrypoint and pin the KAS proceeds legs to the trader/LP P2PK.
// The builders resolve which ABI to emit from optional template flags (`recipientBound`,
// `zeroRemoveAllowed`, `canonicalInventoryRequired`); an ABSENT flag means the LEGACY ABI — the fail-safe
// default, because appending the extra pushes on a legacy schema corrupts the covenant's arg stack, while
// omitting them on a fix schema merely gets the tx rejected. This helper is the ONE place that maps the
// compiler echo's field names onto those flags, so integrators don't hand-roll the mapping (and silently
// miss a discriminator, building transactions every new-schema token rejects):
//
//   curve.recipientBound            ← params.tradeRecipientBound   (HLK-L04)
//   pool.recipientBound             ← params.poolRecipientBound    (HLK-L12)
//   pool.zeroRemoveAllowed          ← params.zeroRemoveAllowed     (HLK-L07)
//   pool.canonicalInventoryRequired ← params.canonicalLpInventory
//
// Hydrate from the COMPILER'S echo (`response.params`), never from the raw registry record: the echo
// reflects the PINNED schema actually compiled, so old-pinned tokens resolve their own (legacy) ABI even
// after the current sources move on. The response also echoes `settleDerivesSlot` / `vestingSupported` /
// `initializerWitnessRequired` — discriminators for the settle/batch/init entrypoints this SDK does not
// build; a future port of those builders hydrates them here the same way.
import type { Kcc20Template } from '../native/kcc20Tx.js';
import type { PoolCpTemplate } from '../native/poolCpTx.js';
import type { CpTemplate } from '../native/curveCpTx.js';

const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));

/** The `POST /api/native/cp-template` response contract (see docs/BUILDING-TRADES.md — spread the token's
 *  registry `curveParams` verbatim into the request, plus `tokenCovid` and `templateVersion`). */
export type CpTemplatesResponse = {
  token: { scriptHex: string; stateStart: number; maxIns: number; maxOuts: number };
  pool: { scriptHex: string; stateStart: number };
  curve: { scriptHex: string; stateStart: number };
  /** buy_order.sil (batch settle) — present on batch-capable schemas; no builder in this SDK yet. */
  order?: { scriptHex: string; stateStart: number; stateLen: number };
  /** The compiler's echo: the baked params + the dual-ABI discriminators (0/1 flags, absent on old backends). */
  params: {
    creatorFeeOwner: string; platformFeeOwner: string;
    vKas: number; graduationKas: number;
    creatorFeeBps: number; platformFeeBps: number; graduationFeeBps: number;
    devFundOwner?: string; devFundBps?: number;
    canonicalLpInventory?: number; zeroRemoveAllowed?: number;
    tradeRecipientBound?: number; poolRecipientBound?: number;
    settleDerivesSlot?: number; vestingSupported?: number; initializerWitnessRequired?: number;
    [key: string]: unknown;
  };
};

/** The shaped templates, ready to hand to the builders. */
export type CpTemplates = { token: Kcc20Template; pool: PoolCpTemplate; curve: CpTemplate };

/** Shape a `cp-template` response into the builders' template objects, hydrating every dual-ABI
 *  discriminator this SDK's builders consume. Pure — bring your own fetch; templates are static per token,
 *  so fetch once and cache (docs/BUILDING-TRADES.md). */
export function shapeCpTemplates(t: CpTemplatesResponse): CpTemplates {
  const p = t.params;
  return {
    token: { script: hexToBytes(t.token.scriptHex), stateStart: t.token.stateStart, maxIns: t.token.maxIns, maxOuts: t.token.maxOuts },
    pool: {
      script: hexToBytes(t.pool.scriptHex), stateStart: t.pool.stateStart,
      canonicalInventoryRequired: !!Number(p.canonicalLpInventory),
      zeroRemoveAllowed: !!Number(p.zeroRemoveAllowed),   // HLK-L07; absent ⇒ legacy throw-on-zero
      recipientBound: !!Number(p.poolRecipientBound),     // HLK-L12; absent ⇒ legacy 4/6-arg pool ABI
    },
    curve: {
      script: hexToBytes(t.curve.scriptHex), stateStart: t.curve.stateStart,
      recipientBound: !!Number(p.tradeRecipientBound),    // HLK-L04; absent ⇒ legacy 4-arg buy/sell
      params: {
        creatorFeeOwner: hexToBytes(p.creatorFeeOwner), platformFeeOwner: hexToBytes(p.platformFeeOwner),
        vKas: BigInt(p.vKas), graduationKas: BigInt(p.graduationKas),
        creatorFeeBps: BigInt(p.creatorFeeBps), platformFeeBps: BigInt(p.platformFeeBps), graduationFeeBps: BigInt(p.graduationFeeBps),
        // Dual-ABI: hydrate the dev-fund leg from the COMPILER'S echo (not the raw record) so the
        // discriminator always reflects the pinned schema actually compiled — old-pinned tokens stay on
        // the two-fee output shape.
        ...(p.devFundOwner != null
          ? { devFundOwner: hexToBytes(String(p.devFundOwner)), devFundBps: BigInt(p.devFundBps!) }
          : {}),
      },
    },
  };
}
