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

export type RegistryToken = {
  tick: string; name: string; creator: string; txid: string; dec: number; max: string;
  description?: string; image?: string;
  links?: { website?: string; x?: string; telegram?: string };
  cp: { curveParams: CpCurveParamsRecord; tokenCovid?: string; curveCovid?: string; poolCovid?: string; genesisTxid?: string };
  chainVerified?: boolean;
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
}
