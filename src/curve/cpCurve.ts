// Virtual-reserve constant-product bonding-curve math — mirrors the curve_cp.sil covenant EXACTLY (BigInt,
// same SCALE / ceil rules) so quotes match what the covenant enforces. The inventory model: a fixed
// inventory is sold/bought at a constant-product price using a virtual KAS reserve; nothing is minted or burned.
export const SCALE = 1_000_000n; // 1e6 sompi = 0.01 KAS — the KAS step used in the CP invariant
// Fee/payment outputs can't be sub-dust (KIP-9 storage mass ≈ C/value), so on-chain fee outputs are padded to
// this floor; quotes reflect the padded amount so the displayed total/net matches what's actually paid.
export const FEE_OUT_MIN = 20_000_000n; // 0.2 TKAS
const padFee = (f: bigint) => (f > FEE_OUT_MIN ? f : FEE_OUT_MIN);
// int64-safety ceiling on the curve UTXO value (sompi) — mirrors curve_cp.sil MAX_KAS. A buy may overbuy PAST
// graduationKas (excess → LP at graduation); this is the only upper bound on a single buy. 9e14 is essentially
// the int64 ceiling: the covenant's graduation `gradFee·10000` peaks at ~9e18 (~2.5% under 2^63).
export const MAX_KAS = 900_000_000_000_000n; // 9e14 sompi = 9,000,000 TKAS

/** Live curve state for quoting. realKas/graduationKas are sompi; vKas is in SCALE units; tokenReserve whole. */
export type CpState = {
  realKas: bigint;        // curve UTXO value (sompi) = KAS raised so far
  tokenReserve: bigint;   // curve inventory remaining (whole tokens)
  vKas: bigint;           // virtual KAS reserve (SCALE units) — sets the opening price
  graduationKas: bigint;  // raised-KAS target (sompi) that unlocks graduation
  creatorFeeBps: bigint;  // e.g. 70n
  platformFeeBps: bigint; // e.g. 30n
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// --- slippage protection ---------------------------------------------------------------------------
// The covenant fixes the trade's output amount into the signed tx and only enforces the constant-product
// FLOOR (it won't let you take MORE than fair), so it does NOT stop the app from baking a WORSE-than-shown
// amount if the curve/pool state moved (another trade landed first) or a node fed stale/bad reserves. Fetch
// fresh state at build time and abort if the achievable output drops below the user-agreed minimum =
// (quote they saw) − tolerance. Default 1%.
export const DEFAULT_SLIPPAGE_BPS = 100;
/** Minimum acceptable output after a slippage tolerance (bps). `out` is tokenOut (buy) or net KAS (sell).
 *  bps is clamped to [0, 10000] (0–100%) so the result never goes negative on an out-of-range tolerance. */
export const minOutWithSlippage = (out: bigint, bps: number): bigint =>
  out - (out * BigInt(Math.min(10000, Math.max(0, Math.round(bps))))) / 10000n;

export type CpBuyQuote = { kasIn: bigint; tokenOut: bigint; creatorFee: bigint; platformFee: bigint; fee: bigint; total: bigint; newRealKas: bigint; newTokenReserve: bigint };
export type CpSellQuote = { tokenIn: bigint; kasOut: bigint; creatorFee: bigint; platformFee: bigint; fee: bigint; net: bigint; newRealKas: bigint; newTokenReserve: bigint };

/** Buy: spend `kasInSompi` into the reserve (floored to a SCALE step) → tokenOut, plus the fee on top. */
export function quoteCpBuy(s: CpState, kasInSompi: bigint): CpBuyQuote | null {
  const ki = kasInSompi / SCALE; // floor to a whole SCALE step (the covenant requires kasIn % SCALE == 0)
  const kasIn = ki * SCALE;
  if (kasIn <= 0n) return null;
  const newRealKas = s.realKas + kasIn;
  if (newRealKas > MAX_KAS) return null; // overbuy past graduationKas is allowed; only the int64 ceiling caps a buy
  const ru = s.realKas / SCALE;
  const K = (s.vKas + ru) * s.tokenReserve;
  const newToken = ceilDiv(K, s.vKas + ru + ki); // pool keeps ≥ the CP tokens (floor check passes)
  const tokenOut = s.tokenReserve - newToken;
  if (tokenOut <= 0n) return null;
  const creatorFee = padFee((kasIn * s.creatorFeeBps) / 10000n);
  const platformFee = padFee((kasIn * s.platformFeeBps) / 10000n);
  const fee = creatorFee + platformFee;
  return { kasIn, tokenOut, creatorFee, platformFee, fee, total: kasIn + fee, newRealKas, newTokenReserve: newToken };
}

/** Sell: return `tokenIn` tokens to inventory → kasOut sompi (a SCALE step), minus the fee. */
export function quoteCpSell(s: CpState, tokenIn: bigint): CpSellQuote | null {
  if (tokenIn <= 0n) return null;
  const ru = s.realKas / SCALE;
  const K = (s.vKas + ru) * s.tokenReserve;
  const newToken = s.tokenReserve + tokenIn;
  const minKasUnits = ceilDiv(K, newToken) - s.vKas; // min units the pool must keep so it isn't drained
  const newKasUnits = minKasUnits < 0n ? 0n : minKasUnits;
  const kasOutUnits = ru - newKasUnits;
  if (kasOutUnits <= 0n) return null; // sell too small to refund a whole SCALE step
  const kasOut = kasOutUnits * SCALE;
  const creatorFee = padFee((kasOut * s.creatorFeeBps) / 10000n);
  const platformFee = padFee((kasOut * s.platformFeeBps) / 10000n);
  const fee = creatorFee + platformFee;
  return { tokenIn, kasOut, creatorFee, platformFee, fee, net: kasOut - fee, newRealKas: s.realKas - kasOut, newTokenReserve: newToken };
}

/** Marginal price in sompi per token: (vKas + realKas/SCALE) · SCALE / tokenReserve. */
export function cpPrice(s: CpState): number {
  if (s.tokenReserve <= 0n) return 0;
  const ru = s.realKas / SCALE;
  return Number((s.vKas + ru) * SCALE) / Number(s.tokenReserve);
}

/** Progress to graduation (0..100), measured by KAS raised vs the target. */
export function cpProgress(s: CpState): number {
  return s.graduationKas > 0n ? Math.min(100, (Number(s.realKas) / Number(s.graduationKas)) * 100) : 0;
}

/** Tokens sold so far (circulating from the curve) = initial inventory − current inventory. */
export const cpSold = (initialInventory: bigint, tokenReserve: bigint): bigint => initialInventory - tokenReserve;
