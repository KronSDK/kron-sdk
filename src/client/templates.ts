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

/** The discriminator fields a supported backend always echoes. A KRON backend that knows about the
 *  recipient-bound schemas emits ALL of these as 0/1 — including `tradeRecipientBound: 0` for a legacy
 *  pinned schema (verified against api.kron.technology on both a legacy and a recipient-bound token). So
 *  "not one of them is present" is unambiguous: the response came from a pre-HLK backend that cannot tell
 *  us which ABI the token wants, and shaping it would silently produce legacy templates. */
const DISCRIMINATORS = ['tradeRecipientBound', 'poolRecipientBound', 'zeroRemoveAllowed', 'canonicalLpInventory'] as const;

/** Shape a `cp-template` response into the builders' template objects, hydrating every dual-ABI
 *  discriminator this SDK's builders consume. Pure — bring your own fetch; templates are static per token,
 *  so fetch once and cache (docs/BUILDING-TRADES.md). Prefer `fetchCpTemplates` unless you need to own the
 *  HTTP call.
 *
 *  @throws if the response carries no ABI discriminators at all — see `DISCRIMINATORS`. */
export function shapeCpTemplates(t: CpTemplatesResponse): CpTemplates {
  const p = t.params;
  if (!p || !DISCRIMINATORS.some((f) => p[f] !== undefined)) {
    throw new Error(
      'cp-template response carries no ABI discriminators (' + DISCRIMINATORS.join(', ') + ') — this backend ' +
        'predates the recipient-bound covenant schemas. Shaping it would silently build the LEGACY ABI, which ' +
        'recipient-bound tokens reject at submit with "pick at an invalid location". Point at a current ' +
        'deployment (e.g. https://api.kron.technology).',
    );
  }
  return {
    token: { script: hexToBytes(t.token.scriptHex), stateStart: t.token.stateStart, maxIns: t.token.maxIns, maxOuts: t.token.maxOuts },
    pool: {
      script: hexToBytes(t.pool.scriptHex), stateStart: t.pool.stateStart,
      canonicalInventoryRequired: !!Number(p.canonicalLpInventory),
      zeroRemoveAllowed: !!Number(p.zeroRemoveAllowed),   // HLK-L07; absent ⇒ legacy throw-on-zero
      recipientBound: !!Number(p.poolRecipientBound),     // HLK-L12; absent ⇒ legacy pool ABI (4/3/6/6 args)
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

/** Options for `fetchCpTemplates`. `templateVersion` is REQUIRED rather than optional on purpose: omitting
 *  it from the compile request makes the backend resolve the CURRENT covenant sources instead of the ones
 *  the token was pinned to, which yields the wrong script bytes AND the wrong ABI flags for any token not on
 *  the newest schema. Passing `null` is the explicit way to say "this registry record has no pin". */
export type FetchCpTemplatesOptions = {
  /** Registry origin, e.g. `https://api.kron.technology` (no path). */
  baseUrl: string;
  /** The token's covid A — `registryToken.cp.tokenCovid`. */
  tokenCovid: string;
  /** `registryToken.cp.curveParams`, spread verbatim. Do not reshape or drop fields (the dev-fund legs in
   *  particular are load-bearing: dropping them builds a tx the covenant rejects). */
  curveParams: Record<string, unknown>;
  /** `registryToken.cp.templateVersion` — pass it through verbatim, or `null` for a pre-pinning record. */
  templateVersion: { schema: string; silverc?: string | null } | null;
  /** Inject a fetch (custom agent, retries, a test double). Defaults to the global. */
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
};

/**
 * Fetch a token's covenant templates from a KRON backend and return them ALREADY SHAPED — the one call that
 * carries the dual-ABI discriminators, so integrators never hand-map `response.params`.
 *
 * Before this existed the SDK exported the builders but left the consumer to hand-roll both the POST and the
 * flag mapping; a template that missed `tradeRecipientBound` type-checked cleanly, built the legacy ABI, and
 * was rejected on-chain with "pick at an invalid location" on exactly the recipient-bound schemas. Use this,
 * or `shapeCpTemplates` if you must own the HTTP call.
 *
 * Templates are static per token — fetch once and cache (the endpoint is compile-rate-limited).
 *
 * ```ts
 * const rec = await new client.RegistryClient('https://api.kron.technology').token('sonar');
 * const tpls = await client.fetchCpTemplates({
 *   baseUrl: 'https://api.kron.technology',
 *   tokenCovid: rec.cp.tokenCovid!,
 *   curveParams: rec.cp.curveParams as unknown as Record<string, unknown>,
 *   templateVersion: rec.cp.templateVersion ?? null,
 * });
 * // tpls.curve.recipientBound is now authoritative for this token's pinned schema.
 * ```
 */
export async function fetchCpTemplates(o: FetchCpTemplatesOptions): Promise<CpTemplates> {
  const f = o.fetchImpl ?? globalThis.fetch;
  if (typeof f !== 'function') throw new Error('no fetch available — pass opts.fetchImpl');
  const url = `${o.baseUrl.replace(/\/+$/, '')}/api/native/cp-template`;
  const body = { ...o.curveParams, tokenCovid: o.tokenCovid, ...(o.templateVersion ? { templateVersion: o.templateVersion } : {}) };
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`cp-template ${res.status}: ${text.slice(0, 300)}`);
  let parsed: CpTemplatesResponse;
  try { parsed = JSON.parse(text) as CpTemplatesResponse; }
  catch { throw new Error(`cp-template returned non-JSON (${text.slice(0, 120)})`); }
  return shapeCpTemplates(parsed);   // throws if this backend echoes no discriminators
}
