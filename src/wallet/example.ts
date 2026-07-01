// A generic, illustrative reference implementation of WalletAdapter — NOT tied to any specific wallet
// product. It targets the shape most Kaspa browser-extension wallets already use for a plain send (an
// injected `window.<walletName>` object with account/connect/sign methods), applied to the signPskt bridge
// described in docs/WALLETS.md. Copy this file and point `GLOBAL_NAME` (and the method calls, if your
// wallet's shape differs — see docs/WALLETS.md "Writing your own adapter") at your own injected provider.
import type { WalletAdapter, WalletCapabilities } from './types.js';

/** Replace with the property name your wallet injects on `window`/`globalThis`. */
const GLOBAL_NAME = 'exampleWallet';

const provider = (): any => {
  const p = (globalThis as any)[GLOBAL_NAME];
  if (!p) throw new Error(`${GLOBAL_NAME} not installed`);
  return p;
};

/**
 * ExampleWalletAdapter — a template, not a real integration. It assumes a provider shaped like:
 *   requestAccounts(): Promise<string[]>
 *   getAccounts(): Promise<string[]>                          // already-authorized, no popup
 *   signPskt({ txJsonString, options: { signInputs } }): Promise<string | { txJsonString }>
 *   getPublicKey(): Promise<string>                            // compressed hex
 *   signMessage(text: string): Promise<string>                 // KIP-5 scheme
 * If your wallet's provider looks different (a different method name, a different sighash encoding, a
 * different signing call shape entirely), adapt the method bodies accordingly — the `WalletAdapter`
 * interface only constrains what you expose, not how you get there.
 */
export class ExampleWalletAdapter implements WalletAdapter {
  readonly provider = GLOBAL_NAME;
  readonly label = 'Example Wallet (template)';
  private address: string | null = null;

  isAvailable() {
    return typeof (globalThis as any)[GLOBAL_NAME] !== 'undefined';
  }

  capabilities(): WalletCapabilities {
    return { signPskt: true, getXOnlyPublicKey: true, signMessage: true, reconnect: true };
  }

  async connect(): Promise<string> {
    const p = provider();
    const accounts: string[] = await p.requestAccounts();
    this.address = accounts?.[0] ?? null;
    if (!this.address) throw new Error('No account authorized');
    return this.address;
  }

  async reconnect(): Promise<string | null> {
    const p = (globalThis as any)[GLOBAL_NAME];
    if (!p) return null;
    try {
      const accounts: string[] = (await p.getAccounts?.()) ?? [];
      if (!accounts.length) return null;
      this.address = accounts[0];
      return this.address;
    } catch { return null; }
  }

  getAddress() { return this.address; }

  async signPskt(txJsonString: string, signInputs: { index: number; sighashType?: number }[]): Promise<string> {
    const p = provider();
    const options = { signInputs: signInputs.map((s) => ({ index: s.index, sighashType: s.sighashType ?? 1 })) };
    const res: any = await p.signPskt({ txJsonString, options });
    return typeof res === 'string' ? res : (res?.txJsonString ?? res?.signedTx ?? res?.tx ?? JSON.stringify(res));
  }

  async getXOnlyPublicKey(): Promise<string | null> {
    const p = provider();
    const pub: string | undefined = await p.getPublicKey?.();
    if (!pub) return null;
    const hex = pub.replace(/^0x/, '');
    return hex.length >= 64 ? hex.slice(-64) : null; // drop the 02/03 compression prefix -> 32-byte x-only
  }

  async signMessage(message: string): Promise<{ signature: string; publicKey: string } | null> {
    const p = provider();
    const publicKey = await this.getXOnlyPublicKey();
    if (!publicKey) return null;
    const signature: string = await p.signMessage(message);
    return { signature, publicKey };
  }

  disconnect() { this.address = null; }
}
