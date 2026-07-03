// Typed wrapper for KRON's token metadata registry (docs/INTEGRATION.md §4 "Token metadata registry" in the
// kron repo). The indexer is the source of truth for amounts/trading state; this registry holds *display*
// metadata the creator signed (name, description, image, social links, the `cp` deploy record). Read-only
// here on purpose — registry WRITES are signature-gated to the on-chain creator key, which is out of scope
// for a generic SDK client (a wallet/bot integrating KRON generally only needs to read this).

export type CpCurveParamsRecord = {
  creatorFeeOwner: string; platformFeeOwner: string;
  vKas: number; graduationKas: number;
  creatorFeeBps: number; platformFeeBps: number; graduationFeeBps: number;
  dexCreatorFeeBps: number; dexPlatformFeeBps: number;
  dexLpFeeBps?: number; poolLockedShares?: number; vestingCovid?: string;
};

/** Covenant version pin (template pinning, KRON ROADMAP 3.5) — stamped by the registry SERVER at
 *  registration, never client-set. `schema` = blake2b-256 over the covenant `.sil` source set the token was
 *  deployed under (the sources live at `covenants/versions/<schema[0..12]>/` in the kron repo); `silverc` =
 *  the pinned compiler commit. A consumer re-deriving the token's covenant templates/addresses from
 *  `curveParams` MUST compile the PINNED source set — compiling newer sources yields different bytes and
 *  wrong addresses. Absent/null = a pre-pinning legacy record (current sources at the time). */
export type TemplateVersionRecord = { schema: string; silverc?: string | null };

/** Optional dev-allocation vesting record (curve_cp.initVested + vesting.sil) — schedule in tx.locktime units. */
export type CpVestingRecord = {
  vestingCovid: string; total: number; startScore: number; durationScore: number;
  genesisTxid: string; outIndex: number;
};

export type RegistryToken = {
  tick: string; name: string; creator: string; txid: string; dec: number; max: string;
  description?: string; image?: string;
  links?: { website?: string; x?: string; telegram?: string };
  cp: {
    curveParams: CpCurveParamsRecord;
    templateVersion?: TemplateVersionRecord | null; // covenant version pin (server-stamped)
    tokenCovid?: string; curveCovid?: string; poolCovid?: string; genesisTxid?: string;
    initialInventory?: number; devAmount?: number;
    vesting?: CpVestingRecord | null;
  };
  creatorPubkey?: string;
  graduated?: boolean;
  chainVerified?: boolean;
  createdAt?: string;
};

/** One entry of the public token list (GET /api/registry/tokenlist). tokenlists.org-shaped: the EVM-core
 *  fields (network/covenantId/symbol/name/decimals/logoURI) plus a KRON `extensions` block. `covenantId`
 *  (covid A) is the canonical TOKEN id (add-to-wallet / asset id); `extensions.poolCovenantId` (covid P) is
 *  the POOL/PAIR id, non-null only post-graduation. `extensions.genesisTxid` is the proof pointer used by
 *  verify.verifyTokenListEntry. Mirrors the `GET /api/registry/tokenlist` response contract. */
export type TokenListEntry = {
  network: string;
  covenantId: string;
  symbol: string; name: string; decimals: number;
  logoURI?: string;
  extensions: {
    curveCovenantId: string | null;
    poolCovenantId: string | null;
    genesisTxid: string | null;
    creator: string | null;
    creatorPubkey: string | null;
    curveParams: CpCurveParamsRecord | null;
    /** Covenant version pin — with `curveParams`, what a covenant-aware auditor needs to re-derive the
     *  curve P2SH (compile the PINNED source set, not the newest). Null = pre-pinning legacy entry. */
    templateVersion: TemplateVersionRecord | null;
    graduated: boolean;
    chainVerified: boolean;
  };
};

/** The token-list envelope (tokenlists.org shape). `version.minor` tracks the token count so a consumer can
 *  cheaply detect list changes. */
export type TokenList = {
  name: string;
  timestamp: string;
  version: { major: number; minor: number; patch: number };
  network: string;
  keywords: string[];
  tokens: TokenListEntry[];
};

export class RegistryClient {
  /** @param baseUrl e.g. 'https://api.kron.technology' (TN10) */
  constructor(private baseUrl: string) {}

  async tokens(): Promise<RegistryToken[]> {
    const res = await fetch(`${this.baseUrl}/api/registry/tokens`);
    if (!res.ok) throw new Error(`registry tokens -> HTTP ${res.status}`);
    const body: { tokens: RegistryToken[] } = await res.json();
    return body.tokens;
  }

  /** Fetch the public token list — a tokenlists.org-shaped index of KRON tokens for wallets/explorers/
   *  aggregators. Default = chain-verified tokens only (anti-phishing); `{ all: true }` adds unverified ones
   *  (each tagged `extensions.chainVerified:false`). Verify any entry against the chain with
   *  verify.verifyTokenListEntry before trusting it. */
  async tokenlist(opts?: { all?: boolean }): Promise<TokenList> {
    const q = opts?.all ? '?all=1' : '';
    const res = await fetch(`${this.baseUrl}/api/registry/tokenlist${q}`);
    if (!res.ok) throw new Error(`registry tokenlist -> HTTP ${res.status}`);
    return (await res.json()) as TokenList;
  }
}
