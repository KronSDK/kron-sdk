// kcc20v1 (KCC-20 standard) family — the G0.3 wallet signing matrix, for wallet developers. A port of KRON's testnet
// developer page `/dev/wallet-matrix` (kron web/src/pages/WalletMatrix.tsx) onto this SDK's own family builders.
//
// What it does: with a connected wallet adapter it builds the four signing shapes the family uses (transfer 1 piece,
// transfer 2 pieces, sell 2 pieces + change, buy 1 merge) over FAKE outpoints, so nothing the wallet signs can ever be
// broadcast. It asks the wallet to sign each shape's listed inputs (the holder's covenant (P2SH) token inputs and its
// P2PK funding input) through `spendV1.signWithWalletV1`, the same signing path and checks the KRON dApp runs:
// `kaspa_signInputs` (KCC-12 §6.7) when the adapter has `signInputs`, else `signPskt` sign-and-extract. Each answer is
// checked as returned (signPskt: only the requested inputs changed, each now the canonical 66-byte `41 ‖ sig64 ‖ 01`;
// signInputs: one 64-byte raw signature, or 65 bytes ending 0x01, per requested input), lifted, spliced into the covenant
// witness and checked again against the assembled transaction. A non-canonical answer fails its shape.
//
// The result is a `KRON-WALLET-MATRIX-1` record, the same JSON the page's "Export record" button prints: per shape the
// path taken, how many inputs were requested, what the wallet returned per input (byte length and trailing byte, never
// the bytes), the error text, the time and the mass. The tester adds the wallet's approval-screen text per shape
// (`approvalScreens` or `withApprovalScreens`) and sends the record to KRON.
//
// Templates: this SDK carries no compiler, so the shapes are built with a bundled reference set (the token and curve
// programs silverc v1.0.0 compiled for the SDK's test params, ./referenceTemplates.ts). The page compiles the same
// programs in the browser with the wallet's key as the curve's creator; the program sizes, the input and output
// layout and the mass are identical, only the creator-fee output pays a fixed test key instead of the wallet. Pass
// `templates` (for example `client.fetchFamilyTemplates(...)`) to build over other programs.
//
// What it does not prove: on-chain acceptance. That needs testnet UTXOs and a node, and runs through the real flows.
// Browser-safe: no Node-only API; the caller supplies the loaded Kaspa WASM (`kron-sdk/wasm` loadKaspa).
import type { Kaspa } from '../wasm/kaspa.types.js';
import type { WalletAdapter } from '../wallet/types.js';
import { compiledFromServerV1, bytesOfHexV1 } from '../native/templatesV1.js';
import { tokenTemplateFromCompiledV1, p2pkOwnedV1, type Kcc20V1Template } from '../native/kcc20V1Tx.js';
import { curveTemplateFromCompiledV1, buildCurveV1Sell, buildCurveV1Buy, type CurveV1Template } from '../native/curveKcc20Tx.js';
import { buildTokenTransferV1 } from '../native/transferKcc20Tx.js';
import { assembleFamilyTx, massDimsV1, type CovenantSpendV1, type AssembledFamilyTx, type FundingEntryV1 } from '../native/covenantTxKcc20V1.js';
import { signWithWalletV1, type FamilySignPath, type FamilyAnswerShape } from '../native/spendV1.js';
import { familyCurveParamsV1 } from '../client/templatesV1.js';
import { REFERENCE_TEMPLATES_V1 } from './referenceTemplates.js';

/** The record format version (the page's `v`). */
export const WALLET_MATRIX_RECORD_VERSION = 'KRON-WALLET-MATRIX-1' as const;

/** The four shapes, in the order they are run. */
export const WALLET_MATRIX_SHAPES = ['transfer (1 piece)', 'transfer (2 pieces)', 'sell (2 pieces + change)', 'buy (1 merge)'] as const;
export type WalletMatrixShapeName = (typeof WALLET_MATRIX_SHAPES)[number];

/** Which G0.3 item each shape answers (the page's list). The witness-length variants are covenant facts proven in KRON's
 *  VM gate, not by a wallet. */
export const WALLET_MATRIX_COVERAGE: readonly string[] = [
  '1-input transfer → transfer (1 piece)',
  '2-piece sell → sell (2 pieces + change)',
  '2 covenant + 1 funding input → transfer (2 pieces)',
  'owner-witness length variants 64/66/0 → covenant facts, proven in the VM by verify:kcc20v1-sighash (wallet-independent)',
  'kaspa_signInputs where offered → the path column',
];

/** The record's fixed note (the page's text). */
export const WALLET_MATRIX_NOTE = 'dry run over fake outpoints — proves the wallet signs the requested inputs with the shapes shown; on-chain acceptance is the tn10 flow run';

/** The two programs the shapes need. `client.fetchFamilyTemplates` / `client.shapeFamilyTemplates` results fit. */
export type WalletMatrixTemplates = { token: Kcc20V1Template; curve: CurveV1Template };

/** One shape, built and assembled: the spend, the unsigned transaction and the inputs the wallet is asked to sign
 *  (funding first, then the holder's token inputs). */
export type WalletMatrixShape = { shape: WalletMatrixShapeName; spend: CovenantSpendV1; asm: AssembledFamilyTx; signIndexes: number[] };

/** Mass per dimension, as decimal strings (JSON has no bigint). */
export type WalletMatrixMass = { compute: string; transient: string; storage: string };

/** One row of the record. `answer` lists, per requested input, its kind, byte length and trailing byte; it never carries
 *  signature bytes. On a failed shape `path`, `requested`, `answer` and `mass` are null and `error` says why. */
export type WalletMatrixResult = {
  shape: WalletMatrixShapeName;
  status: 'ok' | 'error';
  path: FamilySignPath | null;
  requested: number | null;
  answer: FamilyAnswerShape[] | null;
  error: string | null;
  ms: number | null;
  mass: WalletMatrixMass | null;
  approvalScreen: string;
};

export type WalletMatrixWalletInfo = {
  label: string;
  provider: string;
  covenantInputSigning: NonNullable<WalletAdapter['covenantInputSigning']> | null;
  signInputs: boolean;
  signPskt: boolean;
  build: string;
};

/** The exported record (`KRON-WALLET-MATRIX-1`), identical in shape to the page's "Export record" JSON. */
export type WalletMatrixRecord = {
  v: typeof WALLET_MATRIX_RECORD_VERSION;
  recordedAt: string;
  network: string;
  wallet: WalletMatrixWalletInfo | null;
  synthetic: true;
  note: string;
  results: WalletMatrixResult[];
};

export type WalletMatrixProgress =
  | { phase: 'signing'; shape: WalletMatrixShapeName; index: number; of: number; signIndexes: number[] }
  | { phase: 'done'; shape: WalletMatrixShapeName; index: number; of: number; result: WalletMatrixResult };

export type RunWalletMatrixOptions = {
  /** The network id the wallet is on, e.g. `testnet-10`. Mainnet is refused: this is a testnet tool. */
  network: string;
  /** The wallet build / version as the wallet reports it, e.g. `MyWallet 1.4.2 (3f9c2e1)`. Goes into the record. */
  build: string;
  /** Approval-screen text per shape, if already known. Usually added after the run with `withApprovalScreens`. */
  approvalScreens?: Partial<Record<WalletMatrixShapeName, string>>;
  /** Programs to build over instead of the bundled reference set. */
  templates?: WalletMatrixTemplates;
  /** Called before each signing request (so a UI can say which shape the wallet prompt belongs to) and after each shape. */
  onProgress?: (e: WalletMatrixProgress) => void;
};

const KAS = 100_000_000n, DUST = 50_000_000n, NETWORK_FEE = 10_000n;
const RECIPIENT = 'b2'.repeat(32), TOKEN_COVID = '11'.repeat(32), CURVE_COVID = 'cc'.repeat(32);
/** Fake outpoint i: txid = byte (0xa0 + i) repeated 32 times, index 0. No such transaction exists on any network. */
export const fakeOutpoint = (i: number): { transactionId: string; index: number } => ({ transactionId: (0xa0 + i).toString(16).padStart(2, '0').repeat(32), index: 0 });

/** The bundled reference programs, shaped for the builders. Every KCC-1 template hash is recomputed from the bytes. */
export function referenceTemplatesV1(): WalletMatrixTemplates & { schema: string | null } {
  const R = REFERENCE_TEMPLATES_V1;
  const token = tokenTemplateFromCompiledV1(compiledFromServerV1('token', R.token));
  const curve = curveTemplateFromCompiledV1(compiledFromServerV1('curve', R.curve), familyCurveParamsV1(R.params), token);
  return { schema: R.schema, token, curve };
}

const xOnlyHex = (h: unknown): string | null => {
  const s = String(h ?? '').replace(/^0x/, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
};

function assertTestNetwork(network: string): void {
  if (!network) throw new Error('wallet matrix: pass the network id the wallet is on (e.g. testnet-10)');
  if (/^mainnet/i.test(network)) throw new Error(`wallet matrix: refusing network "${network}". This is a testnet tool; run it with a testnet-10 wallet`);
}

/** Build and assemble the four shapes for a holder key over fake outpoints (the page's recipe, step for step). Each
 *  funding input is a 20 KAS P2PK UTXO of `holderPubkey`, labelled with `address`; change goes back to `address`. */
export function buildWalletMatrixShapes(k: Kaspa, o: { holderPubkey: string; address: string; network: string; templates?: WalletMatrixTemplates }): WalletMatrixShape[] {
  const pubHex = xOnlyHex(o.holderPubkey);
  if (!pubHex) throw new Error('wallet matrix: holderPubkey must be a 32-byte x-only public key (64 hex)');
  const kk = k as any;
  const { token, curve } = o.templates ?? referenceTemplatesV1();
  const holder = bytesOfHexV1(pubHex);
  const A = bytesOfHexV1(TOKEN_COVID), C = bytesOfHexV1(CURVE_COVID), recipient = bytesOfHexV1(RECIPIENT);
  const piece = (i: number, amount: bigint) => ({ ...fakeOutpoint(i), value: DUST, state: p2pkOwnedV1(holder, amount) });
  const funding = (i: number): FundingEntryV1 => ({ outpoint: fakeOutpoint(i), amount: 20n * KAS, scriptPublicKey: new kk.ScriptPublicKey(0, `20${pubHex}ac`), blockDaaScore: 0n, isCoinbase: false, address: o.address });
  const assemble = (spend: CovenantSpendV1, f: FundingEntryV1[]) => assembleFamilyTx(k, { spend, fundingEntries: f, changeAddress: o.address, networkFee: NETWORK_FEE, networkId: o.network });
  const live = { graduated: false, tokenCovid: A, tokenReserve: 1_000_000n };
  const curveUtxo = () => ({ ...fakeOutpoint(0), realKas: 100n * KAS, state: live });
  const inventory = () => ({ ...fakeOutpoint(1), value: DUST, amount: 1_000_000n });
  const blake3 = undefined; // p2pk holders only
  const built: [WalletMatrixShapeName, CovenantSpendV1, FundingEntryV1[]][] = [
    ['transfer (1 piece)', buildTokenTransferV1(k, token, A, [piece(0, 1_000n)], holder, recipient, 400n), [funding(1)]],
    ['transfer (2 pieces)', buildTokenTransferV1(k, token, A, [piece(0, 600n), piece(1, 400n)], holder, recipient, 1_000n), [funding(2)]],
    ['sell (2 pieces + change)', buildCurveV1Sell(k, curve, curveUtxo(), [piece(2, 6_000n), piece(3, 4_400n)], inventory(), C, holder, 10_000n, 1n * KAS, { tokenDust: DUST, blake3 }), [funding(4)]],
    ['buy (1 merge)', buildCurveV1Buy(k, curve, curveUtxo(), inventory(), C, holder, 10n * KAS, 9_009n, [piece(2, 500n)], { tokenDust: DUST, blake3 }), [funding(3)]],
  ];
  return built.map(([shape, spend, f]) => {
    const asm = assemble(spend, f);
    return { shape, spend, asm, signIndexes: [...asm.fundingInputIndexes, ...asm.tokenSignInputIndexes] };
  });
}

const now = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/** The record's wallet fields, read from the adapter. */
export function walletMatrixWalletInfo(wallet: WalletAdapter, build: string): WalletMatrixWalletInfo {
  return { label: wallet.label, provider: wallet.provider, covenantInputSigning: wallet.covenantInputSigning ?? null, signInputs: typeof wallet.signInputs === 'function', signPskt: typeof wallet.signPskt === 'function', build: String(build ?? '') };
}

/**
 * Run the four shapes against a connected wallet and return the `KRON-WALLET-MATRIX-1` record.
 *
 * Throws, before any wallet prompt, when the network is mainnet, the adapter has no address or public key, or the
 * address is not the P2PK address of that key on `network`. A shape the wallet refuses, or answers with anything but a
 * canonical signature, is recorded as `status: 'error'` with the reason; the run continues with the next shape.
 *
 * ```ts
 * const k = await loadKaspa();                       // kron-sdk/wasm
 * await adapter.connect();
 * const record = await walletMatrix.runWalletMatrix(k, adapter, { network: 'testnet-10', build: 'MyWallet 1.4.2 (3f9c2e1)' });
 * console.log(walletMatrix.formatWalletMatrixRecord(record));
 * ```
 */
export async function runWalletMatrix(k: Kaspa, wallet: WalletAdapter, opts: RunWalletMatrixOptions): Promise<WalletMatrixRecord> {
  const network = String(opts?.network ?? '');
  assertTestNetwork(network);
  const address = wallet.getAddress();
  if (!address) throw new Error(`wallet matrix: connect ${wallet.label} first (getAddress() returned nothing)`);
  const holderPubkey = xOnlyHex(await wallet.getXOnlyPublicKey?.());
  if (!holderPubkey) throw new Error(`${wallet.label} did not return its public key`);
  const kk = k as any;
  const derived = String(kk.addressFromScriptPublicKey(new kk.ScriptPublicKey(0, `20${holderPubkey}ac`), network)?.toString() ?? '');
  if (derived.toLowerCase() !== String(address).toLowerCase()) {
    throw new Error(`wallet matrix: ${wallet.label}'s address ${address} is not the ${network} address of the public key it returned (${derived}). Check the wallet is on ${network} and getXOnlyPublicKey returns the account's x-only key`);
  }
  const shapes = buildWalletMatrixShapes(k, { holderPubkey, address, network, templates: opts.templates });
  const results: WalletMatrixResult[] = [];
  for (const [index, { shape, spend, asm, signIndexes }] of shapes.entries()) {
    const approvalScreen = opts.approvalScreens?.[shape] ?? '';
    opts.onProgress?.({ phase: 'signing', shape, index, of: shapes.length, signIndexes: [...signIndexes] });
    const t0 = now();
    let row: WalletMatrixResult;
    try {
      const mass = massDimsV1(k, asm.transaction, network, signIndexes);
      const result = await signWithWalletV1(k, wallet, asm, spend, { networkId: network });
      row = { shape, status: 'ok', path: result.path, requested: result.request.signInputs.length, answer: result.answer, error: null, ms: Math.round(now() - t0), mass: { compute: String(mass.compute), transient: String(mass.transient), storage: String(mass.storage) }, approvalScreen };
    } catch (e: any) {
      row = { shape, status: 'error', path: null, requested: null, answer: null, error: String(e?.message ?? e), ms: Math.round(now() - t0), mass: null, approvalScreen };
    }
    results.push(row);
    opts.onProgress?.({ phase: 'done', shape, index, of: shapes.length, result: row });
  }
  return { v: WALLET_MATRIX_RECORD_VERSION, recordedAt: new Date().toISOString(), network, wallet: walletMatrixWalletInfo(wallet, opts.build), synthetic: true, note: WALLET_MATRIX_NOTE, results };
}

/** A copy of the record with the tester's approval-screen text per shape. Unknown shape names are refused. */
export function withApprovalScreens(record: WalletMatrixRecord, texts: Partial<Record<WalletMatrixShapeName, string>>): WalletMatrixRecord {
  for (const key of Object.keys(texts)) if (!(WALLET_MATRIX_SHAPES as readonly string[]).includes(key)) throw new Error(`wallet matrix: unknown shape "${key}" (expected one of: ${WALLET_MATRIX_SHAPES.join(', ')})`);
  return { ...record, results: record.results.map((r) => ({ ...r, approvalScreen: texts[r.shape] ?? r.approvalScreen })) };
}

/** The record as the page prints it (2-space JSON), ready to paste. */
export const formatWalletMatrixRecord = (record: WalletMatrixRecord): string => JSON.stringify(record, null, 2);
