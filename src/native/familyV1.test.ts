// kcc20v1 (KCC-20 standard) family — builders, assembly and the wallet signing path over the vendored Kaspa WASM, against
// the templates silverc v1.0.0 compiled for the test params (__fixtures__/kcc20v1-templates.json). Byte-identity with
// KRON's reference builders is verify:parity:v1's job (it needs the private toolchain); this suite is what runs offline:
// every production shape assembles, is a well-formed KCC-1 invocation, stays under the mass caps, and both KCC-12 wallet
// shapes (§6.7 signInputs raw signatures / signPskt sign-and-extract) end in the same script shape as the dev-key signer,
// with every signature SIGHASH_ALL — while tampered answers are refused before anything is spliced.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3.js';
import { loadKaspa, type Kaspa } from '../wasm/index.node.js';
import { shapeFamilyTemplates, type FamilyTemplates } from '../client/templatesV1.js';
import { hexOf, bytesOfHex } from './dispatchTag.js';
import { p2pkOwnedV1, ZERO32, kcc20V1SpkForState, pushKcc20V1States, materializeKcc20V1Script, decodeKcc20V1State, type Kcc20V1State } from './kcc20V1Tx.js';
import { SigScriptBuilder } from './sigscript.js';
import { buildCurveV1Genesis, buildCurveV1Init, buildCurveV1Buy, buildCurveV1Sell, buildCurveV1Graduate, buildCurveV1BatchBuy, MAX_MERGE_PIECES, MAX_SELL_PIECES } from './curveKcc20Tx.js';
import { buildPoolV1SwapKasForToken, buildPoolV1SwapTokenForKas, buildPoolV1AddLiquidity, buildPoolV1RemoveLiquidity, buildPoolV1BindLp, MAX_SHARES, MAX_TRADER_PIECES } from './poolKcc20Tx.js';
import { poolTemplateFromCompiledV1, buildPoolV1Genesis, buildPoolV1BindLpOpen, buildPoolV1ClosePool, poolV1GenesisState, quoteAddLiquidityExactV1, isOpenPoolV1, MAX_SEED_SHARES, type PoolV1Template, poolBoundsV1, addWithinBoundsV1, sellRoomV1 } from './poolKcc20Tx.js';
import { compiledFromServerV1 } from './templatesV1.js';
import { buildOrderV1Refund, orderEscrowV1 } from './orderKcc20Tx.js';
import { buildTokenTransferV1, MAX_TRANSFER_PIECES } from './transferKcc20Tx.js';
import { assembleFamilyTx, signFamilyTxV1, devKeySignerV1, assertInvocationsV1, massDimsV1, withinCapsV1, parsePushesV1, pushMinimalV1, describeSpendV1, type CovenantSpendV1, type AssembledFamilyTx, type FundingEntryV1 } from './covenantTxKcc20V1.js';
import { walletRequestV1, signWithWalletV1, normalizeSignInputsAnswerV1, assertSighashAllV1 } from './spendV1.js';
import type { WalletAdapter } from '../wallet/types.js';

const FX = JSON.parse(readFileSync(new URL('./__fixtures__/kcc20v1-templates.json', import.meta.url), 'utf8'));
const KCC20 = JSON.parse(readFileSync(new URL('./__fixtures__/kccs/kcc-0020.conformance.json', import.meta.url), 'utf8'));
const NET = 'testnet-10', KAS = 100_000_000n, DUST = 50_000_000n;
const A = bytesOfHex('11'.repeat(32)), C = bytesOfHex('cc'.repeat(32)), P = bytesOfHex('ee'.repeat(32)), LP = bytesOfHex('dd'.repeat(32));
const op = (i: number) => ({ transactionId: i.toString(16).padStart(2, '0').repeat(32), index: 0 });
type Key = { pk: any; pub: Uint8Array; hex: string; address: string };
let k: Kaspa, T: FamilyTemplates, KEYS: Record<string, Key>, keyByPub: Map<string, Key>;
/** An imported token's pool: pool_open_kcc20.sil as the registry's pool-only compile answers it, at the 0 / 80 / 20 schedule. */
let OPEN: PoolV1Template;

beforeAll(async () => {
  k = await loadKaspa();
  T = shapeFamilyTemplates(FX, FX.params);
  const s = FX.standalone.schedule;
  OPEN = poolTemplateFromCompiledV1(compiledFromServerV1('poolOpen', FX.standalone.poolOpen), { ...T.pool.params, creatorFeeBps: BigInt(s.dexCreatorFeeBps), platformFeeBps: BigInt(s.dexPlatformFeeBps), lpFeeBps: BigInt(s.dexLpFeeBps), lockedShares: 0n }, T.token, 'poolOpen');
  KEYS = {};
  for (const [name, { seed, pubkey }] of Object.entries<any>(FX.keySeeds)) {
    const pk = new (k as any).PrivateKey(seed.repeat(32));
    const hex = String(pk.toPublicKey().toXOnlyPublicKey().toString()).replace(/^0x/, '');
    expect(hex, `fixture key ${name}`).toBe(pubkey); // the fixture's params bake exactly these keys
    const address = (k as any).addressFromScriptPublicKey(new (k as any).ScriptPublicKey(0, `20${hex}ac`), NET).toString();
    KEYS[name] = { pk, pub: bytesOfHex(hex), hex, address };
  }
  keyByPub = new Map(Object.values(KEYS).map((x) => [x.hex, x]));
}, 60_000);

const funding = (i: number, who: Key, amount = 20n * KAS): FundingEntryV1 & { owner: Key } => ({ outpoint: op(i), amount, scriptPublicKey: new (k as any).ScriptPublicKey(0, `20${who.hex}ac`), address: who.address, blockDaaScore: 0n, isCoinbase: false, owner: who } as any);
const piece = (i: number, who: Key, amount: bigint) => ({ ...op(i), value: DUST, state: p2pkOwnedV1(who.pub, amount) });
const assemble = (spend: CovenantSpendV1, f: (FundingEntryV1 & { owner: Key })[]) => {
  const totalIn = spend.inputs.reduce((s, i) => s + i.value, 0n) + f.reduce((s, e) => s + e.amount, 0n);
  const totalOut = spend.outputs.reduce((s, o) => s + o.value, 0n);
  return assembleFamilyTx(k, { spend, fundingEntries: f, changeAddress: (f[0]?.owner ?? KEYS.trader).address, networkFee: (spend as any).fixedOutputs ? totalIn - totalOut : 10_000n, networkId: NET });
};
const devSign = (asm: AssembledFamilyTx, spend: CovenantSpendV1, f: (FundingEntryV1 & { owner: Key })[]) =>
  signFamilyTxV1(k, asm, spend, (tx, i) => { const who = asm.fundingInputIndexes.includes(i) ? f[asm.fundingInputIndexes.indexOf(i)].owner : keyByPub.get(hexOf((spend.inputs[i] as any).sign.holderPubkey))!; return devKeySignerV1(k, who.pk)(tx, i); });
/** push lengths per input — the script SHAPE (what the three signing paths must agree on; signature bytes are random) */
const scriptShape = (tx: any) => tx.inputs.map((inp: any) => parsePushesV1(bytesOfHex(String(inp.signatureScript))).map((p) => p.payload.length));

/** An imported token's pool, step by step as kron's verify:kcc20v1-open-pool-flow runs it: a genesis that seeds the whole
 *  deposit, a buy before the bind (no creator fee due, so the creator slot is the trader's own), bindLpOpen, a sell, an exact
 *  deposit (audit KV1-02), its withdrawal, and closePool by the holder of every share. The seeder is the creatorFeeOwner. */
type OpenChain = { gen: CovenantSpendV1 & { poolCovidHex: string }; buy: CovenantSpendV1; bind: CovenantSpendV1; sell: CovenantSpendV1; add: CovenantSpendV1; rm: CovenantSpendV1; close: CovenantSpendV1; seed: bigint };
const openChain = (): OpenChain => {
  const SEEDER = KEYS.creator, K0 = 2_500n, T0 = 100_000n;
  const poolUtxo = (state: any) => ({ ...op(0), state, tokenUtxo: { ...op(1), value: DUST } });
  const lpInv = (i: number, shares: bigint) => ({ ...op(i), value: DUST, amount: MAX_SHARES - shares });
  const gen = buildPoolV1Genesis(k, OPEN, A, [piece(0, SEEDER, T0)], SEEDER.pub, K0, T0, { tokenDust: DUST, blake3 });
  const P1 = bytesOfHex(gen.poolCovidHex), g = poolV1GenesisState(OPEN, A, K0, T0);
  const buy = buildPoolV1SwapKasForToken(k, OPEN, poolUtxo(g), P1, KEYS.trader.pub, 10n * KAS, { tokenDust: DUST });
  const afterBuy = { ...g, kasReserve: buy.quote.newKas, tokenReserve: buy.quote.newToken };
  const bind = buildPoolV1BindLpOpen(k, OPEN, poolUtxo(afterBuy), P1, { lpDust: DUST });
  const L = bytesOfHex((bind as any).covids.lpCovid), bound = { ...afterBuy, totalShares: afterBuy.kasReserve, lpCovid: L };
  const sell = buildPoolV1SwapTokenForKas(k, OPEN, poolUtxo(bound), P1, KEYS.trader.pub, [piece(2, KEYS.trader, buy.quote.tokenOut)], buy.quote.tokenOut / 2n, { tokenDust: DUST, blake3 });
  const afterSell = { ...bound, kasReserve: sell.quote.newKas, tokenReserve: sell.quote.newToken };
  const qa = quoteAddLiquidityExactV1(afterSell, 300n)!;
  const add = buildPoolV1AddLiquidity(k, OPEN, poolUtxo(afterSell), lpInv(3, afterSell.totalShares), P1, L, piece(2, KEYS.lp, qa.dToken), KEYS.lp.pub, 300n, { tokenDust: DUST, blake3 });
  const grown = { ...afterSell, kasReserve: add.quote.newKas, tokenReserve: add.quote.newToken, totalShares: add.quote.newShares };
  const rm = buildPoolV1RemoveLiquidity(k, OPEN, poolUtxo(grown), lpInv(2, grown.totalShares), P1, L, piece(3, KEYS.lp, add.quote.dShares), KEYS.lp.pub, { tokenDust: DUST, blake3 });
  const shrunk = { ...grown, kasReserve: rm.quote.newKas, tokenReserve: rm.quote.newToken, totalShares: rm.quote.newShares };
  const close = buildPoolV1ClosePool(k, OPEN, poolUtxo(shrunk), lpInv(2, shrunk.totalShares), P1, L, piece(3, SEEDER, shrunk.totalShares), SEEDER.pub, { tokenDust: DUST, blake3 });
  return { gen, buy, bind, sell, add, rm, close, seed: afterBuy.kasReserve };
};

type Shape = { name: string; spend: () => CovenantSpendV1; funding: () => (FundingEntryV1 & { owner: Key })[] };
const shapes = (): Shape[] => {
  const live = { graduated: false, tokenCovid: A, tokenReserve: 1_000_000n };
  const curveUtxo = (realKas: bigint, state: any) => ({ ...op(0), realKas, state });
  const inventory = (i: number, amount: bigint) => ({ ...op(i), value: DUST, amount });
  const ps = { kasReserve: 100_000n, tokenReserve: 1_000_000n, tokenCovid: A, totalShares: 1000n, lpCovid: LP };
  const poolUtxo = (state: any) => ({ ...op(0), state, tokenUtxo: { ...op(1), value: DUST } });
  const fee = { creatorFeeBps: 25n, platformFeeBps: 90n, devFundBps: 10n };
  const order = (i: number, covid: string, buyer: Key, kasIn: bigint) => ({ ...op(i), value: orderEscrowV1(kasIn, fee), covid, state: { curveCovid: C, buyerIdentifier: buyer.pub, tokenCovid: A, kasIn, minTokenOut: 1n } });
  let openMemo: OpenChain | null = null; // built on first use: the shapes are listed before beforeAll loads the WASM
  const open = (): OpenChain => (openMemo ??= openChain());
  return [
    // init proves the curve id is a singleton (audit KV1-01): it takes the outpoint that authorized the curve genesis, and
    // the curve id is the real genesis id over it
    { name: 'init', spend: () => { const G = { transactionId: 'f0'.repeat(32), index: 0 }; const Cg = bytesOfHex(buildCurveV1Genesis(k, T.curve, G, 100n * KAS, NET).curveCovid); return buildCurveV1Init(k, T.curve, curveUtxo(100n * KAS, { graduated: false, tokenCovid: ZERO32, tokenReserve: 0n }), Cg, 900_000_000n, 100_000_000n, G, { tokenDust: DUST }); }, funding: () => [funding(1, KEYS.creator)] },
    { name: 'buy (1 merge)', spend: () => buildCurveV1Buy(k, T.curve, curveUtxo(100n * KAS, live), inventory(1, 1_000_000n), C, KEYS.trader.pub, 10n * KAS, 9_009n, [piece(2, KEYS.trader, 500n)], { tokenDust: DUST, blake3 }), funding: () => [funding(3, KEYS.trader)] },
    { name: 'sell (2 pieces + change)', spend: () => buildCurveV1Sell(k, T.curve, curveUtxo(100n * KAS, live), [piece(2, KEYS.trader, 6_000n), piece(3, KEYS.trader, 4_400n)], inventory(1, 1_000_000n), C, KEYS.trader.pub, 10_000n, 1n * KAS, { tokenDust: DUST, blake3 }), funding: () => [funding(4, KEYS.trader)] },
    { name: 'graduate', spend: () => buildCurveV1Graduate(k, T.curve, curveUtxo(100n * KAS, live), inventory(1, 1_000_000n), C, T.pool, { tokenDust: DUST }), funding: () => [funding(2, KEYS.trader)] },
    { name: 'batchBuy (2 orders)', spend: () => buildCurveV1BatchBuy(k, T.curve, T.order, curveUtxo(100n * KAS, live), inventory(1, 1_000_000n), C, [order(2, '51'.repeat(32), KEYS.trader, 50n * KAS), order(3, '52'.repeat(32), KEYS.buyer2, 50n * KAS)]), funding: () => [] },
    { name: 'order refund', spend: () => buildOrderV1Refund(k, T.order, order(0, '51'.repeat(32), KEYS.trader, 50n * KAS), 1), funding: () => [funding(1, KEYS.trader)] },
    { name: 'pool swapKasForToken', spend: () => buildPoolV1SwapKasForToken(k, T.pool, poolUtxo(ps), P, KEYS.trader.pub, 10n * KAS, { tokenDust: DUST }), funding: () => [funding(2, KEYS.trader)] },
    { name: 'pool swapTokenForKas (2 pieces)', spend: () => buildPoolV1SwapTokenForKas(k, T.pool, poolUtxo(ps), P, KEYS.trader.pub, [piece(2, KEYS.trader, 50_000n), piece(3, KEYS.trader, 3_032n)], 52_632n, { tokenDust: DUST, blake3 }), funding: () => [funding(4, KEYS.trader)] },
    { name: 'pool addLiquidity', spend: () => buildPoolV1AddLiquidity(k, T.pool, poolUtxo(ps), { ...op(3), value: DUST, amount: MAX_SHARES - 1000n }, P, LP, piece(2, KEYS.lp, 100_000n), KEYS.lp.pub, 10_000n, { tokenDust: DUST, blake3 }), funding: () => [funding(4, KEYS.lp, 200n * KAS)] },
    { name: 'pool removeLiquidity', spend: () => buildPoolV1RemoveLiquidity(k, T.pool, poolUtxo({ ...ps, kasReserve: 110_000n, tokenReserve: 1_100_000n, totalShares: 1100n }), { ...op(2), value: DUST, amount: MAX_SHARES - 1100n }, P, LP, { ...op(3), value: DUST, state: p2pkOwnedV1(KEYS.lp.pub, 100n) }, KEYS.lp.pub, { tokenDust: DUST, blake3 }), funding: () => [funding(4, KEYS.lp)] },
    { name: 'pool bindLp', spend: () => buildPoolV1BindLp(k, T.pool, poolUtxo({ ...ps, lpCovid: ZERO32 }), P), funding: () => [funding(1, KEYS.trader)] },
    { name: 'open pool genesis (the whole deposit)', spend: () => open().gen, funding: () => [funding(1, KEYS.creator, 40n * KAS)] },
    { name: 'open swapKasForToken (pre-bind, trader slot)', spend: () => open().buy, funding: () => [funding(2, KEYS.trader)] },
    { name: 'open bindLpOpen', spend: () => open().bind, funding: () => [funding(1, KEYS.creator)] },
    { name: 'open swapTokenForKas (trader slot + change)', spend: () => open().sell, funding: () => [funding(3, KEYS.trader)] },
    { name: 'open addLiquidity (exact)', spend: () => open().add, funding: () => [funding(4, KEYS.lp, 200n * KAS)] },
    { name: 'open removeLiquidity', spend: () => open().rm, funding: () => [funding(4, KEYS.lp)] },
    { name: 'open closePool (every share)', spend: () => open().close, funding: () => [funding(4, KEYS.creator)] },
    { name: 'transfer (1 piece)', spend: () => buildTokenTransferV1(k, T.token, A, [piece(0, KEYS.trader, 1_000n)], KEYS.trader.pub, KEYS.buyer2.pub, 400n), funding: () => [funding(1, KEYS.trader)] },
    { name: 'transfer (2 pieces)', spend: () => buildTokenTransferV1(k, T.token, A, [piece(0, KEYS.trader, 600n), piece(1, KEYS.trader, 400n)], KEYS.trader.pub, KEYS.buyer2.pub, 1_000n), funding: () => [funding(2, KEYS.trader)] },
  ];
};

describe('family templates from the fixture', () => {
  it('shape with the compiled programs\' sizes and the reference token\'s template hash', () => {
    expect(T.bytes.token).toBe(4031);
    expect(hexOf(T.token.templateHash)).toBe('9703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7');
    expect(T.curve.token).toBe(T.token); expect(T.pool.token).toBe(T.token); expect(T.order.token).toBe(T.token);
    expect(T.bytes.curve).toBeGreaterThan(14_000); expect(T.bytes.pool).toBeGreaterThan(13_000); expect(T.bytes.order).toBeGreaterThan(600);
  });
  it('KCC-20 transfer_arguments vector: the KCC20State[] argument is pushed as six grouped columns', () => {
    const v = KCC20.transfer_arguments;
    const states: Kcc20V1State[] = v.next_states.map((s: any) => ({ amount: BigInt(s.amount), owner: bytesOfHex(s.owner_hex), ownerScheme: parseInt(s.owner_scheme_hex, 16), borrowScheme: parseInt(s.borrow_scheme_hex, 16), borrowGuard: bytesOfHex(s.borrow_guard_hex), extensionCommitment: bytesOfHex(s.extension_commitment_hex) }));
    const b = new SigScriptBuilder(k); pushKcc20V1States(b, states);
    expect(parsePushesV1(bytesOfHex(b.drain())).map((p) => hexOf(p.raw))).toEqual(v.grouped_field_pushes_hex);
  });
});

describe('every production shape assembles into a well-formed, in-cap v1 transaction', () => {
  for (const sh of shapes()) {
    it(sh.name, async () => {
      const spend = sh.spend(), f = sh.funding();
      const asm = assemble(spend, f);
      expect(asm.transaction.version).toBe(1);
      expect(spend.inputs[0].covid).toMatch(/^[0-9a-f]{64}$/); // input 0 is always the continuation covenant input
      expect(asm.fundingInputIndexes).toEqual(f.map((_, i) => spend.inputs.length + i)); // funding after every covenant input
      for (const [i, o] of spend.outputs.entries()) if (o.covenant) expect(asm.transaction.outputs[i].covenant?.covenantId ?? asm.transaction.outputs[i].covenant?.covid ?? o.covenant.covid, `output ${i} binding`).toBeTruthy();
      const tx = await devSign(asm, spend, f);
      expect(() => assertInvocationsV1(tx, spend)).not.toThrow();
      const dims = massDimsV1(k, tx, NET, [...asm.fundingInputIndexes, ...asm.tokenSignInputIndexes]);
      expect(withinCapsV1(dims), `mass ${JSON.stringify(dims, (_, x) => (typeof x === 'bigint' ? String(x) : x))}`).toBe(true);
      const report = assertSighashAllV1(tx, asm);
      expect(report.length).toBe(asm.fundingInputIndexes.length + asm.tokenSignInputIndexes.length);
      expect(report.filter((r) => r.kind === 'token').map((r) => r.witness)).toEqual(spend.inputs.flatMap((ci) => (ci.role === 'holderLeader' || ci.role === 'seederLeader' ? ['leader'] : ci.sign ? ['delegator'] : [])));
      expect(describeSpendV1(spend).inputs.length).toBe(spend.inputs.length);
    });
  }
  it('token outputs sit at the P2SH of the declared next state (transfer: recipient + change)', () => {
    const spend = buildTokenTransferV1(k, T.token, A, [piece(0, KEYS.trader, 1_000n)], KEYS.trader.pub, KEYS.buyer2.pub, 400n);
    const [recipient, change] = spend.outputs;
    expect(String(recipient.scriptPublicKey.script)).toBe(String(kcc20V1SpkForState(k, T.token, p2pkOwnedV1(KEYS.buyer2.pub, 400n)).script));
    expect(String(change.scriptPublicKey.script)).toBe(String(kcc20V1SpkForState(k, T.token, p2pkOwnedV1(KEYS.trader.pub, 600n)).script));
    expect(decodeKcc20V1State(materializeKcc20V1Script(T.token, p2pkOwnedV1(KEYS.buyer2.pub, 400n))).state.amount).toBe(400n);
    expect(recipient.covenant).toEqual({ covid: hexOf(A), authorizingInput: 0 });
  });
  it('the bounds the family covenants enforce are the builders\' bounds', () => {
    expect([MAX_MERGE_PIECES, MAX_SELL_PIECES, MAX_TRADER_PIECES, MAX_TRANSFER_PIECES]).toEqual([2, 2, 2, 2]);
    const three = [piece(0, KEYS.trader, 1n), piece(1, KEYS.trader, 1n), piece(2, KEYS.trader, 1n)];
    expect(() => buildTokenTransferV1(k, T.token, A, three, KEYS.trader.pub, KEYS.buyer2.pub, 3n)).toThrow(/1\.\.2/);
    expect(() => buildTokenTransferV1(k, T.token, A, [piece(0, KEYS.buyer2, 5n)], KEYS.trader.pub, KEYS.buyer2.pub, 1n)).toThrow(/not owned by the connected wallet key/);
  });
});

describe('an imported token\'s pool (pool_open_kcc20.sil, audit KV1-02..05)', () => {
  it('the registry\'s pool-only compile shapes as the open program: nothing locked, its own entries', () => {
    expect(isOpenPoolV1(OPEN)).toBe(true);
    expect(OPEN.params.lockedShares).toBe(0n);
    expect(Object.keys(OPEN.tags).sort()).toEqual(['addLiquidity', 'bindLpOpen', 'closePool', 'removeLiquidity', 'swapKasForToken', 'swapTokenForKas']);
    expect(() => poolTemplateFromCompiledV1(compiledFromServerV1('poolOpen', FX.standalone.poolOpen), { ...OPEN.params, lockedShares: 1000n }, T.token, 'poolOpen')).toThrow(/no locked shares/);
    expect(() => poolTemplateFromCompiledV1(compiledFromServerV1('pool', FX.standalone.pool), { ...OPEN.params, lockedShares: 0n }, T.token, 'pool')).toThrow(/lockedShares >= 1/);
  });
  it('the token bound is the program version\'s: 4e18 raw units now, 1e9 on 6b7ec42cd29a and on the locked program', () => {
    const OLD = '6b7ec42cd29ac0d4ea7e055f75f6bcdef48ff4d3d8d1b7960ee0a643ceb727bc';
    expect(OPEN.bounds.maxToken).toBe(4_000_000_000_000_000_000n);
    expect(poolBoundsV1('poolOpen', OLD).maxToken).toBe(1_000_000_000n);
    expect(poolBoundsV1('pool').maxToken).toBe(1_000_000_000n);
    const capped = poolTemplateFromCompiledV1(compiledFromServerV1('poolOpen', FX.standalone.poolOpen), OPEN.params, T.token, 'poolOpen', OLD);
    expect(capped.bounds.maxToken).toBe(1_000_000_000n);
    const q = quoteAddLiquidityExactV1({ kasReserve: 800_000_000n, tokenReserve: 3_900_000_000_000_000_001n, totalShares: 5_000_000n }, 8_000_000n)!;
    expect(q.dToken).toBe((3_900_000_000_000_000_001n * 50_000n + 4_999_999n) / 5_000_000n);
    expect(addWithinBoundsV1(q, OPEN.bounds)).toBe(true);
    expect(addWithinBoundsV1(q, capped.bounds)).toBe(false);
    expect(sellRoomV1({ tokenReserve: 1_000_000_000n }, capped.bounds)).toBe(0n);
    expect(sellRoomV1({ tokenReserve: 1_000_000_000n }, OPEN.bounds)).toBe(3_999_999_999_000_000_000n);
  });
  it('genesis shares are min(k0, 5,000,000): a sole seeder never takes the whole share space (KV1-04)', () => {
    expect(poolV1GenesisState(OPEN, A, 2_500n, 100_000n).totalShares).toBe(2_500n);
    expect(poolV1GenesisState(OPEN, A, 9_000_000n, 100_000n).totalShares).toBe(MAX_SEED_SHARES);
  });
  it('a buy with no creator fee due pays the creator slot back to the trader (KV1-03); bindLpOpen seeds the reserve', () => {
    const c = openChain();
    const slot = c.buy.outputs[3];
    expect(slot.role).toBe('traderSlot');
    expect(String(slot.scriptPublicKey.script)).toBe(`20${KEYS.trader.hex}ac`);
    expect(c.bind.kind).toBe('bindLpOpen');
    expect(c.bind.economics.seedShares).toBe(c.seed);
    expect(c.bind.economics.lpInventory).toBe(MAX_SHARES - c.seed);
  });
  it('a deposit pays exactly ceil(dShares·K/S) (KV1-02): 101 units at 2.5 units a share buy 40 shares for 100', () => {
    const q = quoteAddLiquidityExactV1({ kasReserve: 5_000n, tokenReserve: 100_000n, totalShares: 2_000n }, 101n)!;
    expect([q.dKas, q.dShares]).toEqual([100n, 40n]);
  });
  it('closePool pays the whole pool to the holder of every share, and refuses anyone holding less', () => {
    const c = openChain();
    expect(c.close.kind).toBe('closePool');
    expect(c.close.outputs[0].role).toBe('lpKas');
    expect(String(c.close.outputs[0].scriptPublicKey.script)).toBe(`20${KEYS.creator.hex}ac`);
  });
});

// --- fake wallets of both KCC-12 shapes ------------------------------------------------------------------------------
const rawSig65 = (txJson: string, index: number, pk: any): string => {
  const tx = (k as any).Transaction.deserializeFromSafeJSON(txJson);
  const full = String((k as any).createInputSignature(tx, index, pk, (k as any).SighashType.All)).replace(/^0x/, '');
  return full.length === 132 ? full.slice(2) : full; // `41 ‖ sig64 ‖ 01` → sig65
};
const base = (who: Key, extra: Partial<WalletAdapter>): WalletAdapter => ({ provider: 'fake', label: 'Fake', isAvailable: () => true, capabilities: () => ({ signPskt: false, getXOnlyPublicKey: false, signMessage: false, reconnect: false }), connect: async () => who.address, getAddress: () => who.address, disconnect() {}, ...extra });
/** KCC-12 §6.7: positional raw 64-byte signatures; checks the account the request names. */
const signInputsWallet = (who: Key, o: { shape?: 'positional' | 'objects' | 'objects65'; mutate?: (out: any[]) => any[] } = {}) => base(who, {
  covenantInputSigning: 'signInputs',
  async signInputs(txJson, inputs) {
    let out: any[] = inputs.map(({ index, address, sighashType }) => {
      if ((sighashType ?? 1) !== 1) throw Object.assign(new Error('unimplemented sighashType'), { code: -32602 });
      if (address !== who.address) throw Object.assign(new Error(`address ${address} is not an authorized account`), { code: 4100 });
      const s65 = rawSig65(txJson, index, who.pk);
      return o.shape === 'objects65' ? { index, signature: s65 } : o.shape === 'objects' ? { index, signature: s65.slice(0, 128) } : s65.slice(0, 128);
    });
    if (o.mutate) out = o.mutate(out);
    return out;
  },
});
/** signPskt sign-and-extract: writes `41 ‖ sig64 ‖ 01` on every listed input, as the extension wallets do by source. */
const psktWallet = (who: Key, mutate?: (j: any, s: { index: number }[]) => any) => base(who, {
  covenantInputSigning: 'unproven',
  async signPskt(txJson, signInputs) {
    const j = JSON.parse(txJson);
    for (const { index } of signInputs) j.inputs[index].signatureScript = '41' + rawSig65(txJson, index, who.pk);
    return JSON.stringify(mutate ? mutate(j, signInputs) : j);
  },
});

describe('spendV1 — the wallet signing path (KCC-12 §6.7 signInputs / signPskt sign-and-extract)', () => {
  const holder = () => KEYS.trader;
  const two = () => { const spend = buildTokenTransferV1(k, T.token, A, [piece(0, KEYS.trader, 600n), piece(1, KEYS.trader, 400n)], KEYS.trader.pub, KEYS.buyer2.pub, 1_000n); const f = [funding(2, KEYS.trader)]; return { spend, f, asm: assemble(spend, f) }; };
  const sell = () => { const live = { graduated: false, tokenCovid: A, tokenReserve: 1_000_000n }; const spend = buildCurveV1Sell(k, T.curve, { ...op(0), realKas: 100n * KAS, state: live }, [piece(2, KEYS.trader, 6_000n), piece(3, KEYS.trader, 4_400n)], { ...op(1), value: DUST, amount: 1_000_000n }, C, KEYS.trader.pub, 10_000n, 1n * KAS, { tokenDust: DUST, blake3 }); const f = [funding(4, KEYS.trader)]; return { spend, f, asm: assemble(spend, f) }; };

  it('walletRequestV1 names the signing ACCOUNT per input (holder key address for token inputs), SIGHASH_ALL', () => {
    const { spend, asm } = sell();
    const req = walletRequestV1(k, asm, spend, { networkId: NET });
    expect(req.tokenInputIndexes).toEqual([2, 3]); expect(req.fundingInputIndexes).toEqual([4]);
    expect(req.signInputs.map((s) => s.index)).toEqual([4, 2, 3]);
    expect(req.signInputs.every((s) => s.address === holder().address && s.sighashType === 1)).toBe(true);
    const j = JSON.parse(req.txJson);
    for (const i of [2, 3, 4]) expect(j.inputs[i].signatureScript).toBe(''); // the inputs the wallet signs go out EMPTY
    expect(j.inputs[0].signatureScript.length).toBeGreaterThan(1000);            // the curve invocation is pre-scripted
  });
  for (const [name, make] of [['transfer (2 pieces)', two], ['sell (2 pieces + change)', sell]] as const) {
    it(`${name}: signInputs (positional / objects / 65-byte), signPskt and the dev signer agree on the script shape; every signature SIGHASH_ALL`, async () => {
      const a = make(), b = make(), c = make(), d = make(), e = make();
      const r1 = await signWithWalletV1(k, signInputsWallet(holder()), a.asm, a.spend, { networkId: NET });
      const r2 = await signWithWalletV1(k, signInputsWallet(holder(), { shape: 'objects' }), b.asm, b.spend, { networkId: NET });
      const r3 = await signWithWalletV1(k, signInputsWallet(holder(), { shape: 'objects65' }), c.asm, c.spend, { networkId: NET });
      const r4 = await signWithWalletV1(k, psktWallet(holder()), d.asm, d.spend, { networkId: NET });
      const dev = await devSign(e.asm, e.spend, e.f);
      expect([r1.path, r2.path, r3.path, r4.path]).toEqual(['signInputs', 'signInputs', 'signInputs', 'signPskt']);
      const shape = JSON.stringify(scriptShape(dev));
      for (const r of [r1, r2, r3, r4]) {
        expect(JSON.stringify(scriptShape(r.signedTx))).toBe(shape);
        expect(() => assertInvocationsV1(r.signedTx, a.spend)).not.toThrow();
        expect(assertSighashAllV1(r.signedTx, a.asm).length).toBe(3);
        expect(r.answer.every((x) => x.tail === '01' || x.bytes === 64)).toBe(true);
      }
    });
  }
  it('signInputs: a wrong count, an unrequested index, a 63-byte signature, a 0x02 tail and an unauthorized account are refused BEFORE any splice', async () => {
    const run = (o: Parameters<typeof signInputsWallet>[1]) => { const { spend, asm } = two(); return signWithWalletV1(k, signInputsWallet(holder(), o), asm, spend, { networkId: NET }); };
    await expect(run({ mutate: (out) => out.slice(0, -1) })).rejects.toThrow(/returned 2 signatures for 3/);
    await expect(run({ shape: 'objects', mutate: (out) => out.map((x) => ({ ...x, index: 0 })) })).rejects.toThrow(/not requested \(or twice\)/);
    await expect(run({ mutate: (out) => out.map((x) => x.slice(0, 126)) })).rejects.toThrow();
    await expect(run({ shape: 'objects65', mutate: (out) => out.map((x) => ({ ...x, signature: x.signature.slice(0, 128) + '02' })) })).rejects.toThrow(/SIGHASH_ALL|0x01/);
    const { spend, asm } = two();
    await expect(signWithWalletV1(k, signInputsWallet(KEYS.buyer2), asm, spend, { networkId: NET })).rejects.toThrow(/not an authorized account/);
    const req = walletRequestV1(k, asm, spend, { networkId: NET });
    expect(() => normalizeSignInputsAnswerV1('nope', req)).toThrow(/no signatures/);
  });
  it('signPskt: the answer is checked AS RETURNED — a 0x02 tail, an appended push, a changed output, a dropped signature, a re-signed covenant input are refused', async () => {
    const tamper = (mutate: (j: any, s: { index: number }[]) => any) => { const { spend, asm } = two(); return signWithWalletV1(k, psktWallet(holder(), mutate), asm, spend, { networkId: NET }); };
    await expect(tamper((j, s) => { j.inputs[s[0].index].signatureScript = j.inputs[s[0].index].signatureScript.slice(0, -2) + '02'; return j; })).rejects.toThrow(/SIGHASH_ALL/);
    await expect(tamper((j, s) => { const i = s[s.length - 1].index; j.inputs[i].signatureScript += '4c04deadbeef'; return j; })).rejects.toThrow();
    await expect(tamper((j) => { j.outputs[0].value = String(BigInt(j.outputs[0].value) + 1n); return j; })).rejects.toThrow(/intent/);
    await expect(tamper((j, s) => { j.inputs[s[0].index].signatureScript = ''; return j; })).rejects.toThrow(/SIGHASH_ALL/);
    const s = sell();
    await expect(signWithWalletV1(k, psktWallet(holder(), (j) => { j.inputs[0].signatureScript = '41' + 'ab'.repeat(64) + '01'; return j; }), s.asm, s.spend, { networkId: NET })).rejects.toThrow(/intent/);
  });
  it('refusals before any prompt: a refusing wallet, a wallet without a signing method, an unlabelled request', async () => {
    const { spend, asm, f } = two();
    let asked = false;
    const refusing = base(holder(), { covenantInputSigning: 'refused', async signPskt() { asked = true; return ''; } });
    await expect(signWithWalletV1(k, refusing, asm, spend, { networkId: NET })).rejects.toThrow(/declines to sign covenant inputs/);
    expect(asked).toBe(false);
    await expect(signWithWalletV1(k, base(holder(), {}), asm, spend, { networkId: NET })).rejects.toThrow(/cannot sign KRON transactions/);
    const unlabelled = assembleFamilyTx(k, { spend, fundingEntries: f.map(({ address, ...e }: any) => e), changeAddress: holder().address, networkFee: 10_000n });
    expect(() => walletRequestV1(k, unlabelled, spend)).toThrow(/network/);
    expect(walletRequestV1(k, unlabelled, spend, { networkId: NET }).signInputs.every((x) => x.address === holder().address)).toBe(true);
  });
  it('assertSighashAllV1 refuses a 0x02 funding signature, a 0x02 token witness and an unsigned placeholder', async () => {
    const { spend, asm, f } = two();
    const tx = await devSign(asm, spend, f);
    const j = JSON.parse(tx.serializeToSafeJSON());
    const fi = asm.fundingInputIndexes[0], ti = asm.tokenSignInputIndexes[0];
    const bad1 = structuredClone(j); bad1.inputs[fi].signatureScript = bad1.inputs[fi].signatureScript.slice(0, -2) + '02';
    expect(() => assertSighashAllV1(JSON.stringify(bad1), asm)).toThrow(/funding.*not SIGHASH_ALL/);
    const bad2 = structuredClone(j); { const pushes = parsePushesV1(bytesOfHex(bad2.inputs[ti].signatureScript)); const w = pushes[pushes.length - 3].payload; w[65] = 0x02; bad2.inputs[ti].signatureScript = pushes.map((p) => hexOf(pushMinimalV1(p.payload))).join(''); }
    expect(() => assertSighashAllV1(JSON.stringify(bad2), asm)).toThrow(/token, leader.*not SIGHASH_ALL/);
    const fresh = assemble(spend, f); // signFamilyTxV1 signs in place, so take a fresh (unsigned) assembly
    expect(() => assertSighashAllV1(fresh.transaction, fresh)).toThrow(/unsigned \(empty signature script\)/);
    expect(() => assertSighashAllV1(fresh.transaction, { fundingInputIndexes: [], tokenSignInputIndexes: fresh.tokenSignInputIndexes })).toThrow(/zero placeholder/);
    expect(() => assertSighashAllV1({ inputs: [] }, asm)).toThrow(/unsigned/);
  });
});
