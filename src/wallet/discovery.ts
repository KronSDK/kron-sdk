// Kaspa provider discovery — kron-sdk's implementation of KIP-12, the Kaspa wallet provider and
// discovery standard (https://github.com/kaspanet/kips — kip-0012; original draft: kips PR #21).
//
// THE KIP IS THE AUTHORITATIVE SPECIFICATION. This module implements it directly and is
// self-contained (zero dependencies): the canonical announce event `kaspa:provider`, the node's bare
// network ids (`mainnet`, `testnet-10`, …), and the `chainChanged` provider event. The types below
// match the KIP's formal interfaces (kip-0012/interfaces.ts); the export names are kron-sdk API
// surface and are unchanged from earlier releases — only the wire values moved to KIP-12 canonical.
// See docs/WALLETS.md for integration guidance.

// ============================================================================================
// Network identifiers (KIP-12 §5)
// ============================================================================================

/** Canonical network ids — the node's own strings, per KIP-12. */
export const KASPA_NETWORKS = {
  MAINNET: 'mainnet',
  TESTNET_10: 'testnet-10',
  TESTNET_11: 'testnet-11',
  DEVNET: 'devnet',
} as const;

export type KaspaNetworkId = (typeof KASPA_NETWORKS)[keyof typeof KASPA_NETWORKS];

/** Normalize a wallet-reported network id to canonical KIP-12 form: `kaspa_`-prefixed dialects
 *  (e.g. KasWare's injected API: `kaspa_mainnet`, `kaspa_testnet_10`) map to the bare node ids. */
export const normalizeKaspaNetworkId = (id: string): string =>
  id.startsWith('kaspa_') ? id.slice('kaspa_'.length).replace(/_/g, '-') : id;

// ============================================================================================
// Discovery handshake (KIP-12 §2)
// ============================================================================================

/** Dispatched on `window` by a dApp to ask all present wallets to (re-)announce themselves. */
export const KASPA_REQUEST_PROVIDER_EVENT = 'kaspa:requestProvider';
/** Dispatched on `window` by a wallet; `detail` is a frozen {@link KaspaProviderDetail}. */
export const KASPA_ANNOUNCE_PROVIDER_EVENT = 'kaspa:provider';

/** Identity a wallet announces about itself. `name`/`icon` are DISPLAY hints — never trust signals. */
export type KaspaProviderInfo = {
  /** UUIDv4, freshly generated per page load — instance identity, used only for dedupe. */
  uuid: string;
  /** Human-readable wallet name shown in pickers, e.g. "Kastle". */
  name: string;
  /** Wallet icon as a `data:` URI (SVG/PNG) — dApps MUST refuse remote URLs (KIP-12 § Security). */
  icon: string;
  /** Reverse-DNS identifier, e.g. "com.kasware" — STABLE across page loads; enables session restore. */
  rdns?: string;
};

/** One input a wallet is asked to sign, by position. `sighashType` 1 = SIGHASH_ALL; a wallet MUST
 *  refuse a type it does not implement rather than guess (KIP-12 §4.1). */
export type KaspaSignInput = { index: number; sighashType: number };

/**
 * The provider surface a wallet exposes (KIP-12 §3). Only `requestAccounts` is REQUIRED; everything
 * else is OPTIONAL and MUST be capability-checked by the dApp before use.
 *
 * FUND-SAFETY (KIP-12 §4.1): `signPskt` MUST sign ONLY the inputs listed in `options.signInputs`
 * and MUST leave every other input untouched — covenant transactions carry pre-authorized inputs
 * that must not be re-signed.
 */
export interface KaspaProvider {
  /** Connect: prompt the user if needed; resolve to the authorized address list (active first). */
  requestAccounts(): Promise<string[]>;
  /** Already-authorized accounts WITHOUT prompting (empty if none) — silent session restore. */
  getAccounts?(): Promise<string[]>;
  /** Current network id (canonical, see {@link KASPA_NETWORKS}). */
  getNetwork?(): Promise<string>;
  switchNetwork?(networkId: string): Promise<void>;
  /** Active account public key hex (compressed 33-byte or x-only 32-byte — both accepted). */
  getPublicKey?(): Promise<string>;
  /** KIP-5 message signing; resolves to the Schnorr signature hex. */
  signMessage?(message: string): Promise<string>;
  /** Sign ONLY the listed inputs of a Kaspa Safe-JSON transaction; returns the signed Safe-JSON. */
  signPskt?(arg: { txJsonString: string; options: { signInputs: KaspaSignInput[] } }): Promise<string>;
  disconnect?(origin?: string): Promise<void>;
  /** `chainChanged` is the KIP-12 network-change event (payload: canonical network id). */
  on?(event: 'accountsChanged' | 'chainChanged', handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
}

/** The frozen `detail` of a `kaspa:provider` CustomEvent. */
export type KaspaProviderDetail = { info: KaspaProviderInfo; provider: KaspaProvider };

/**
 * WALLET SIDE — call once when your content script loads. Announces immediately AND replays on every
 * `kaspa:requestProvider` (KIP-12 §2: a wallet MUST do both — replying only to requests leaves it
 * invisible to a dApp that asked before it injected). Returns an unsubscribe. No-op outside a window.
 */
export function announceKaspaWallet(info: KaspaProviderInfo, provider: KaspaProvider): () => void {
  if (typeof window === 'undefined') return () => {};
  const detail: KaspaProviderDetail = Object.freeze({ info: Object.freeze({ ...info }), provider });
  const announce = () =>
    window.dispatchEvent(new CustomEvent(KASPA_ANNOUNCE_PROVIDER_EVENT, { detail }));
  window.addEventListener(KASPA_REQUEST_PROVIDER_EVENT, announce);
  announce();
  return () => window.removeEventListener(KASPA_REQUEST_PROVIDER_EVENT, announce);
}

/** An icon is safe to render only as an inline `data:` URI — a remote URL is a tracking/spoofing
 *  vector (KIP-12 § Security), so the dApp-side handshake refuses it. */
const isSafeIcon = (icon: unknown): icon is string =>
  typeof icon === 'string' && /^data:/i.test(icon.trim());

/**
 * dApp SIDE — register `onAnnounce` (fires once per announce event, including replays; dedupe by
 * `info.rdns ?? info.uuid` yourself), then request announcements from wallets already present. Keep
 * the subscription alive for the page lifetime to catch late-injecting wallets. Returns an
 * unsubscribe. Malformed announces are dropped; a non-`data:` icon is STRIPPED to `''` before the
 * announce reaches your callback (the wallet is still surfaced). Neither filter authenticates the
 * announcer — the user's explicit connect gesture is the trust boundary (KIP-12 § Security).
 * No-op outside a window context.
 */
export function requestKaspaWallets(onAnnounce: (detail: KaspaProviderDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<KaspaProviderDetail>).detail;
    if (!detail?.info?.uuid || !detail?.info?.name) return;
    if (typeof detail.provider?.requestAccounts !== 'function') return;
    if (detail.info.icon != null && !isSafeIcon(detail.info.icon)) {
      onAnnounce({ info: { ...detail.info, icon: '' }, provider: detail.provider });
      return;
    }
    onAnnounce(detail);
  };
  window.addEventListener(KASPA_ANNOUNCE_PROVIDER_EVENT, listener);
  window.dispatchEvent(new Event(KASPA_REQUEST_PROVIDER_EVENT));
  return () => window.removeEventListener(KASPA_ANNOUNCE_PROVIDER_EVENT, listener);
}
