// Wallet abstraction — one interface, swappable implementations. This is the shape KRON's non-custodial
// signing flow needs: build the transaction, hand specific inputs to a wallet to sign, broadcast. It is NOT
// an officially standardized Kaspa wallet API (none exists yet — see README) — a working pattern this
// package promotes as a reusable interface, illustrated by the generic reference implementation in
// `example.ts`. See `docs/WALLETS.md` for how to implement this against a real wallet's injected provider.
//
// Capability-flag pattern: every signing method beyond `connect`/`getAddress`/`disconnect` is OPTIONAL on
// the interface, because not every wallet implements every capability — check `capabilities()` rather than
// assuming a method exists.
export type Provider = string;
export type Connected = { provider: Provider; address: string };

/** Which of the optional signing capabilities a given adapter instance actually implements. Check this
 *  before relying on a method — an adapter that returns `signPskt: false` will throw if you call it anyway. */
export type WalletCapabilities = {
  signPskt: boolean;
  getXOnlyPublicKey: boolean;
  signMessage: boolean;
  reconnect: boolean;
};

export interface WalletAdapter {
  readonly provider: Provider;
  readonly label: string;
  /** Wallet icon as a `data:` URI (SVG/PNG), for wallet pickers. dApps should refuse remote URLs. */
  readonly icon?: string;
  isAvailable(): boolean;
  /** Which optional methods this adapter actually implements (vs. throws on call). */
  capabilities(): WalletCapabilities;
  /** Connect/authorize; resolves to the active kaspa:/kaspatest: address. */
  connect(): Promise<string>;
  /** Silently restore a prior session on page load WITHOUT prompting the user (an already-authorized
   *  accounts lookup with no popup, if the wallet supports one). Resolves to the address, or null if there
   *  is nothing to restore. */
  reconnect?(): Promise<string | null>;
  getAddress(): string | null;
  /**
   * The signPskt wallet bridge: sign ONLY the listed inputs (the user's P2PK inputs) of a tx (Safe JSON)
   * and return the signed tx (Safe JSON). Covenant inputs are never signed by the wallet — their
   * transition rules / presence-based ownership authorize them. This is what makes sell/transfer work with
   * existing wallets without KRON ever holding a key. See ../native/spend.ts `toPsktJson`.
   */
  signPskt?(txJsonString: string, signInputs: { index: number; sighashType?: number }[]): Promise<string>;
  /** The connected account's 32-byte x-only pubkey hex (the curve/pool fee owner at deploy, or a
   *  presence-owned token's owner identifier). null if unavailable. */
  getXOnlyPublicKey?(): Promise<string | null>;
  /** Sign a UTF-8 message with the account key (KIP-5 Kaspa message-signing scheme — see README "Message
   *  signing"). Returns the Schnorr signature hex + the signer's x-only pubkey hex. null if unavailable. */
  signMessage?(message: string): Promise<{ signature: string; publicKey: string } | null>;
  /** Subscribe to account switches in the wallet (empty array = user revoked/locked). Returns an
   *  unsubscribe. Omit if the underlying wallet has no account-change events. */
  onAccountsChanged?(handler: (accounts: string[]) => void): () => void;
  disconnect(): void;
}

/** Thrown by a wallet adapter method that exists on the interface but isn't implemented by a given wallet.
 *  Distinct from a generic Error so callers can detect "not supported" vs. "failed". */
export class WalletCapabilityError extends Error {
  constructor(public readonly provider: Provider, public readonly method: string, hint?: string) {
    super(`${provider} does not implement ${method}()${hint ? ` — ${hint}` : ''}`);
    this.name = 'WalletCapabilityError';
  }
}
