// Kaspa provider discovery — RE-EXPORTED from the standalone standard this SDK helped define and now
// dogfoods: `kaspa-wallet-standard` (https://github.com/kaspa-wallet-standard/kaspa-wallet-standard).
//
// The discovery handshake (kaspa:announceProvider / kaspa:requestProvider), the KaspaProvider interface,
// and the announce/request helpers live in that zero-dependency package so wallets and other dApps can
// adopt the exact same contract without depending on KRON's SDK. Re-exporting here means kron-sdk's
// discovery surface IS the standard's — one source of truth, zero drift. See docs/WALLETS.md.
//
// NB: explicit named re-exports (not `export *`) — a bundler cannot re-export the *named* bindings of an
// EXTERNAL package via `export *` (it can't see their names at build time), so the names would silently
// vanish. Listing them keeps `kaspa-wallet-standard` a real runtime dependency while surfacing its API.
// The standard's wire contract is frozen, so this list is stable.
export {
  KASPA_NETWORKS,
  KASPA_ANNOUNCE_PROVIDER_EVENT,
  KASPA_REQUEST_PROVIDER_EVENT,
  announceKaspaWallet,
  requestKaspaWallets,
} from 'kaspa-wallet-standard';

export type {
  KaspaNetworkId,
  KaspaProviderInfo,
  KaspaSignInput,
  KaspaProvider,
  KaspaProviderDetail,
} from 'kaspa-wallet-standard';
