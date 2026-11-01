// Run KRON's wallet signing matrix against your wallet extension (testnet-10, no funds needed).
//
// Drop this into any ESM browser bundle (for example `npm create vite@latest`, then replace src/main.ts), install
// @kronsdk/kron-sdk, put your wallet on testnet-10 and open the page. The wallet is asked to sign four transactions
// over fake outpoints; nothing it signs can be broadcast. Send the printed record to KRON together with what your
// approval screen showed for each of the four requests.
import { wallet, walletMatrix } from '@kronsdk/kron-sdk';
import { loadKaspa } from '@kronsdk/kron-sdk/wasm';

// 1. Find the wallet. KIP-12 wallets announce themselves; a wallet that injects a global instead (window.kasware, ...)
//    can set `p` to that object, as long as it has the same requestAccounts / getPublicKey / signPskt methods.
const detail = await new Promise<wallet.KaspaProviderDetail>((resolve, reject) => {
  wallet.requestKaspaWallets(resolve);
  setTimeout(() => reject(new Error('no KIP-12 wallet announced itself')), 3000);
});
const p: any = detail.provider;

// 2. Wrap it in the SDK's WalletAdapter. These are the only calls the matrix makes on your provider.
let address: string | null = null;
const adapter: wallet.WalletAdapter = {
  provider: detail.info.rdns ?? detail.info.id,
  label: detail.info.name,
  covenantInputSigning: typeof p.signInputs === 'function' ? 'signInputs' : 'unproven',
  isAvailable: () => true,
  capabilities: () => ({ signPskt: typeof p.signPskt === 'function', signInputs: typeof p.signInputs === 'function', getXOnlyPublicKey: true, signMessage: false, reconnect: false }),
  connect: async () => { address = (await p.requestAccounts())[0] ?? null; if (!address) throw new Error('no account authorized'); return address; },
  getAddress: () => address,
  getXOnlyPublicKey: async () => { const h = String(await p.getPublicKey()).replace(/^0x/, ''); return h.length === 66 ? h.slice(2) : h; },
  // signPskt sign-and-extract: sign the listed inputs, covenant (P2SH) token inputs included, and return the Safe JSON.
  ...(typeof p.signPskt === 'function' && { signPskt: async (txJsonString: string, signInputs: { index: number; sighashType?: number }[]) => { const r = await p.signPskt({ txJsonString, options: { signInputs } }); return typeof r === 'string' ? r : r.txJsonString; } }),
  // KCC-12 §6.7 kaspa_signInputs, if your wallet has it: one raw 64-byte signature per listed input. Preferred when present.
  ...(typeof p.signInputs === 'function' && { signInputs: (txJsonString: string, signInputs: { index: number; address: string; sighashType?: number }[]) => p.signInputs({ transaction: txJsonString, txJsonString, signInputs }) }),
  disconnect: () => { address = null; },
};

// 3. Connect, run the four shapes, print the record.
const k = await loadKaspa();
await adapter.connect();
const record = await walletMatrix.runWalletMatrix(k, adapter, {
  network: 'testnet-10',
  build: 'MyWallet 1.4.2 (3f9c2e1)', // your build / version, as the wallet reports it
  onProgress: (e) => { if (e.phase === 'signing') console.log(`approve "${e.shape}": ${e.signIndexes.length} inputs`); },
});
const text = walletMatrix.formatWalletMatrixRecord(record);
console.log(text);
document.body.appendChild(document.createElement('pre')).textContent = text;
// Add your approval-screen text per shape before sending:
//   walletMatrix.withApprovalScreens(record, { 'transfer (1 piece)': '...', 'transfer (2 pieces)': '...', ... })
