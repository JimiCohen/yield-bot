/**
 * Concentrated-liquidity math for SCORING (double precision).
 *
 * Scoring compares yield estimates, where ~1e-15 relative float error is
 * irrelevant. Execution-phase math (tick boundaries, minOut amounts) must
 * NOT use this module — it stays in bigint space (Phase 8).
 *
 * Conventions:
 *  - "raw" = smallest token denomination (wei-style).
 *  - s = sqrtPriceX96 / 2^96, the raw sqrt price (token1raw per token0raw).
 *  - A symmetric range with width multiplier m spans [P/m, P*m] around the
 *    current price P, i.e. sqrt bounds [s/sqrt(m), s*sqrt(m)].
 */

export interface PoolPricing {
  sqrtPriceX96: bigint;
  dec0: number;
  dec1: number;
  /** USD price of one whole token0 / token1 */
  p0Usd: number;
  p1Usd: number;
}

export function sRaw(sqrtPriceX96: bigint): number {
  return Number(sqrtPriceX96) / 2 ** 96;
}

/**
 * Concentration leverage of a width-m position vs a full-range position of
 * equal capital. Both fee share AND LVR scale by this same factor while the
 * price is in range — that identity is the heart of the fees-vs-LVR model.
 *
 * Derivation: position value at center = 2·L·s·(1 − m^(−1/2)) in token1 raw
 * units; full range is the m→∞ limit 2·L·s. Equal capital ⇒
 * L(m)/L(∞) = 1/(1 − m^(−1/2)).
 */
export function leverage(m: number): number {
  return 1 / (1 - 1 / Math.sqrt(m));
}

/** Liquidity units purchasable with `usd` capital, centered, width m. */
export function liquidityForUsd(p: PoolPricing, usd: number, m: number): number {
  const s = sRaw(p.sqrtPriceX96);
  const valueToken1Raw = usd / (p.p1Usd / 10 ** p.dec1);
  return valueToken1Raw / (2 * s * (1 - 1 / Math.sqrt(m)));
}

/**
 * USD value of the pool's virtual reserves on each side at the current tick.
 * Used for size-aware swap impact: within the active tick a CL pool behaves
 * as constant-product on virtual reserves x = L/s (token0), y = L·s (token1).
 */
export function virtualReservesUsd(
  liquidity: bigint,
  p: PoolPricing,
): { v0Usd: number; v1Usd: number } {
  const s = sRaw(p.sqrtPriceX96);
  const L = Number(liquidity);
  return {
    v0Usd: (L / s) * (p.p0Usd / 10 ** p.dec0),
    v1Usd: L * s * (p.p1Usd / 10 ** p.dec1),
  };
}

/**
 * Price-impact fraction for swapping `amountUsd` into the pool, from
 * constant-product math on virtual reserves: impact = dx / (x + dx).
 *
 * Exact within the active tick; OVERSTATES impact for swaps that cross into
 * fresh liquidity, which is the conservative direction for a cost estimate.
 * Direction-agnostic: uses the smaller virtual side (worst case).
 */
export function swapImpactFraction(
  liquidity: bigint,
  p: PoolPricing,
  amountUsd: number,
): number {
  const { v0Usd, v1Usd } = virtualReservesUsd(liquidity, p);
  const vIn = Math.min(v0Usd, v1Usd);
  if (vIn <= 0) return 1;
  return amountUsd / (vIn + amountUsd);
}

/** Minimum representable width multiplier for a pool's tick spacing:
 *  a position must span at least one spacing, so pb/pa >= 1.0001^spacing
 *  and m = sqrt(pb/pa). */
export function minWidthForSpacing(tickSpacing: number): number {
  return Math.pow(1.0001, tickSpacing / 2);
}

/**
 * Exact USD value of a CL position with liquidity L and sqrt-price bounds
 * [sa, sb] (raw), at current raw sqrt price sNow. Clamping sNow into the
 * band handles both out-of-range cases (all token0 below, all token1 above).
 * Position value is path-independent between rebalances, so endpoint
 * valuation in the backtest is exact, not an approximation.
 */
export function positionValueUsd(
  L: number,
  sa: number,
  sb: number,
  sNow: number,
  p: { dec0: number; dec1: number; p0Usd: number; p1Usd: number },
): number {
  const s = Math.min(Math.max(sNow, sa), sb);
  const amt0 = L * (1 / s - 1 / sb);
  const amt1 = L * (s - sa);
  return amt0 * (p.p0Usd / 10 ** p.dec0) + amt1 * (p.p1Usd / 10 ** p.dec1);
}

/**
 * Probability that a Brownian bridge between log-price endpoints x0, x1
 * (both inside the band) touched the nearest band edge during the interval.
 * Single-barrier formula P = exp(−2·d0·d1/σ²Δt), taking the more likely
 * barrier — a lower bound on the two-barrier union, which slightly
 * UNDERSTATES fee loss; the engine applies it conservatively (see caller).
 */
export function bridgeTouchProb(
  x0: number,
  x1: number,
  bandLo: number,
  bandHi: number,
  sigmaSqDt: number,
): number {
  if (sigmaSqDt <= 0) return 0;
  const pHi = Math.exp((-2 * (bandHi - x0) * (bandHi - x1)) / sigmaSqDt);
  const pLo = Math.exp((-2 * (x0 - bandLo) * (x1 - bandLo)) / sigmaSqDt);
  return Math.min(1, Math.max(pHi, pLo));
}

/**
 * First-exit-time statistics for a driftless log-price diffusion with
 * annualized vol `sigma`, starting centered in a band of half-width
 * ln(m_eff) (deadband included by the caller via m_eff).
 *
 *   E[T_exit] = b² / σ²  (years), b = ln(m_eff)
 *
 * Drift is deliberately ignored: assuming zero drift is the conservative,
 * no-view stance for rebalance frequency (any drift only shortens exits).
 */
export function expectedExitYears(mEff: number, sigmaAnnual: number): number {
  const b = Math.log(mEff);
  if (sigmaAnnual <= 0) return Infinity;
  return (b * b) / (sigmaAnnual * sigmaAnnual);
}
