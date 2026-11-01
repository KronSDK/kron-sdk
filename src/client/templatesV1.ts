// kcc20v1 (KCC-20 standard) family — fetch a family token's FOUR compiled templates from a KRON registry
// (`POST /api/native/kcc20v1-template`) and return them SHAPED for the family builders, with every KCC-1 template hash
// recomputed from the bytes (native/templatesV1.ts compiledFromServerV1). The family twin of fetchCpTemplates: the server
// compiles the token's PINNED covenant version (`cp.templateVersion.schema`) with its baked params (`cp.curveParams`);
// templates are static per token — fetch once, keep. Mirrors kron's web/src/familyTemplates.ts (the server path).
import type { CompiledV1, FamilyTemplatesResponseV1 } from '../native/templatesV1.js';
import { familyFromServerV1 } from '../native/templatesV1.js';
import { bytesOfHex } from '../native/dispatchTag.js';
import { tokenTemplateFromCompiledV1, type Kcc20V1Template } from '../native/kcc20V1Tx.js';
import { curveTemplateFromCompiledV1, type CurveV1Template, type CurveV1Params } from '../native/curveKcc20Tx.js';
import { poolTemplateFromCompiledV1, type PoolV1Template, type PoolV1Params } from '../native/poolKcc20Tx.js';
import { orderTemplateFromCompiledV1, type OrderV1Template } from '../native/orderKcc20Tx.js';

/** The compiler defaults the registry applies when a record omits the field — ONE value across both families (kron
 *  verify:locked-shares-parity): pool shares locked at graduation, and the pool's LP fee. */
export const POOL_LOCKED_SHARES_DEFAULT_V1 = 1000n;
export const DEX_LP_FEE_BPS_DEFAULT_V1 = 20n;

/** `registryToken.cp.curveParams` of a family record (`cp.family === 'kcc20v1'`). Hex fields are 32-byte x-only keys;
 *  numeric fields may arrive as numbers or decimal strings. `devFundOwner`/`devFundBps` are REQUIRED for a family record
 *  (the server refuses to compile without them); `dexLpFeeBps` / `poolLockedShares` fall back to the compiler defaults. */
export type FamilyCurveParamsInput = {
  creatorFeeOwner: string; platformFeeOwner: string; devFundOwner?: string | null;
  vKas: string | number; graduationKas: string | number;
  creatorFeeBps: string | number; platformFeeBps: string | number; graduationFeeBps: string | number; devFundBps?: string | number | null;
  dexCreatorFeeBps: string | number; dexPlatformFeeBps: string | number; dexLpFeeBps?: string | number | null; poolLockedShares?: string | number | null;
  [key: string]: unknown;
};

const key32 = (what: string, v: unknown): Uint8Array => {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/i.test(v)) throw new Error(`curveParams.${what} must be a 32-byte x-only pubkey hex`);
  return bytesOfHex(v);
};
const big = (what: string, v: unknown, fallback?: bigint): bigint => {
  if (v == null) { if (fallback !== undefined) return fallback; throw new Error(`curveParams.${what} is required for a KCC-20 standard-family token`); }
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new Error(`curveParams.${what} is not an integer`);
};

/** The curve program's params as the builders take them (`curveTemplateFromCompiledV1`). `creatorIdentifier` is the
 *  creator fee owner (the family's dev allocation goes to the creator key). */
export function familyCurveParamsV1(p: FamilyCurveParamsInput): CurveV1Params {
  const creator = key32('creatorFeeOwner', p.creatorFeeOwner);
  return {
    creatorFeeOwner: creator, platformFeeOwner: key32('platformFeeOwner', p.platformFeeOwner), devFundOwner: key32('devFundOwner', p.devFundOwner), creatorIdentifier: creator,
    vKas: big('vKas', p.vKas), graduationKas: big('graduationKas', p.graduationKas),
    creatorFeeBps: big('creatorFeeBps', p.creatorFeeBps), platformFeeBps: big('platformFeeBps', p.platformFeeBps), graduationFeeBps: big('graduationFeeBps', p.graduationFeeBps), devFundBps: big('devFundBps', p.devFundBps),
    poolLockedShares: big('poolLockedShares', p.poolLockedShares, POOL_LOCKED_SHARES_DEFAULT_V1),
  };
}
/** The pool program's params as the builders take them (`poolTemplateFromCompiledV1`). */
export function familyPoolParamsV1(p: FamilyCurveParamsInput): PoolV1Params {
  return {
    creatorFeeOwner: key32('creatorFeeOwner', p.creatorFeeOwner), platformFeeOwner: key32('platformFeeOwner', p.platformFeeOwner),
    creatorFeeBps: big('dexCreatorFeeBps', p.dexCreatorFeeBps), platformFeeBps: big('dexPlatformFeeBps', p.dexPlatformFeeBps),
    lpFeeBps: big('dexLpFeeBps', p.dexLpFeeBps, DEX_LP_FEE_BPS_DEFAULT_V1), lockedShares: big('poolLockedShares', p.poolLockedShares, POOL_LOCKED_SHARES_DEFAULT_V1),
  };
}

/** The fields the compile route accepts — an allow-list, because the route REFUSES audited-family keys (`maxIns`,
 *  `maxOuts`, `vesting`) and a record spread verbatim could carry them. */
export const FAMILY_COMPILE_KEYS = ['creatorFeeOwner', 'platformFeeOwner', 'devFundOwner', 'vKas', 'graduationKas', 'creatorFeeBps', 'platformFeeBps', 'graduationFeeBps', 'devFundBps', 'dexCreatorFeeBps', 'dexPlatformFeeBps', 'dexLpFeeBps', 'poolLockedShares'] as const;
/** The JSON body of `POST /api/native/kcc20v1-template` for one token. */
export function familyCompileBodyV1(curveParams: FamilyCurveParamsInput, o: { tokenCovid?: string | null; templateVersion?: { schema: string } | null } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of FAMILY_COMPILE_KEYS) if (curveParams[k] != null) body[k] = curveParams[k];
  if (o.tokenCovid) body.tokenCovid = o.tokenCovid;
  if (o.templateVersion?.schema) body.templateVersion = { family: 'kcc20v1', schema: o.templateVersion.schema };
  return body;
}

export type FamilyTemplates = {
  /** the covenant version the server compiled (its answer's `templateVersion.schema`), or null when it did not say */
  schema: string | null;
  token: Kcc20V1Template; curve: CurveV1Template; pool: PoolV1Template; order: OrderV1Template;
  /** the verified compiled programs the shaped templates were built from */
  compiled: { token: CompiledV1; curve: CompiledV1; pool: CompiledV1; order: CompiledV1 };
  /** revealed-script sizes per program (prefix + state + suffix) — what the fee disclosure needs */
  bytes: { token: number; curve: number; pool: number; order: number };
};

/** Shape a compile answer (already fetched) into builder templates. Recomputes every KCC-1 template hash and refuses a
 *  program whose compiled dispatch tags disagree with the entry signatures the builders encode (dispatchTag.ts). */
export function shapeFamilyTemplates(r: FamilyTemplatesResponseV1, curveParams: FamilyCurveParamsInput): FamilyTemplates {
  const c = familyFromServerV1(r);
  const token = tokenTemplateFromCompiledV1(c.token);
  const curve = curveTemplateFromCompiledV1(c.curve, familyCurveParamsV1(curveParams), token);
  const pool = poolTemplateFromCompiledV1(c.pool, familyPoolParamsV1(curveParams), token);
  const order = orderTemplateFromCompiledV1(c.order, token);
  const tv = (r as any).templateVersion;
  const schema = tv && typeof tv.schema === 'string' ? tv.schema.toLowerCase() : null;
  return { schema, token, curve, pool, order, compiled: c, bytes: { token: c.token.bytecode.length, curve: c.curve.bytecode.length, pool: c.pool.bytecode.length, order: c.order.bytecode.length } };
}

export type FetchFamilyTemplatesOptions = {
  /** Registry origin, e.g. `https://api.kron.technology` (no path). */
  baseUrl: string;
  /** The token's covid A — `registryToken.cp.tokenCovid` (optional: the family's programs do not bake it). */
  tokenCovid?: string | null;
  /** `registryToken.cp.curveParams` of a record with `cp.family === 'kcc20v1'`. */
  curveParams: FamilyCurveParamsInput;
  /** `registryToken.cp.templateVersion` — REQUIRED (pass `null` only for a record without a pin, which compiles the
   *  registry's CURRENT family sources; a pinned token compiled against newer sources yields different bytes and
   *  wrong addresses). */
  templateVersion: { schema: string; silverc?: string | null } | null;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
};

/**
 * Fetch and shape a KCC-20 standard-family token's templates.
 *
 * ```ts
 * const rec = await new client.RegistryClient(API).token('ghost');
 * if (rec.cp.family !== 'kcc20v1') throw new Error('not a standard-family token — use fetchCpTemplates');
 * const t = await client.fetchFamilyTemplates({ baseUrl: API, tokenCovid: rec.cp.tokenCovid, curveParams: rec.cp.curveParams as any, templateVersion: rec.cp.templateVersion ?? null });
 * // t.curve / t.pool / t.order / t.token go straight into curveKcc20.* / poolKcc20.* / orderKcc20.* / transferKcc20.*
 * ```
 */
export async function fetchFamilyTemplates(o: FetchFamilyTemplatesOptions): Promise<FamilyTemplates> {
  const f = o.fetchImpl ?? globalThis.fetch;
  if (typeof f !== 'function') throw new Error('no fetch available — pass opts.fetchImpl');
  const url = `${o.baseUrl.replace(/\/+$/, '')}/api/native/kcc20v1-template`;
  const body = familyCompileBodyV1(o.curveParams, { tokenCovid: o.tokenCovid, templateVersion: o.templateVersion });
  const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(o.signal ? { signal: o.signal } : {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`kcc20v1-template ${res.status}: ${text.slice(0, 300)}`);
  let parsed: FamilyTemplatesResponseV1;
  try { parsed = JSON.parse(text) as FamilyTemplatesResponseV1; } catch { throw new Error(`kcc20v1-template: non-JSON response: ${text.slice(0, 120)}`); }
  const shaped = shapeFamilyTemplates(parsed, o.curveParams);
  if (o.templateVersion?.schema && shaped.schema && shaped.schema !== o.templateVersion.schema.toLowerCase()) throw new Error(`kcc20v1-template: the server compiled schema ${shaped.schema.slice(0, 12)}…, not the token's pinned ${o.templateVersion.schema.slice(0, 12)}…`);
  return shaped;
}
