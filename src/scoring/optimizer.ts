import type { Config } from "../config/schema.js";
import {
  expectedExitYears,
  leverage,
  liquidityForUsd,
  minWidthForSpacing,
  quantizeWidth,
  swapImpactFraction,
  type PoolPricing,
} from "./clmath.js";
import type { FeeRateEstimate } from "./fees.js";
import type { VolEstimate } from "./volatility.js";
import type { AeroPricing } from "./emissions.js";
import { realizableAeroUsd } from "./emissions.js";

/**
 * Fees-vs-LVR width optimizer.
 *
 * For each candidate width m (range [P/m, P*m]) and each yield arm, compute
 * net USDC over the horizon:
 *
 *   J(m) = conf · arm_yield(L(m)) · η(m)          [gross yield, in range]
 *        − (σ²/8) · ℓ(m) · C · H · η(m)           [LVR while in range]
 *        − N_rebal(m) · cost_rebalance            [recentering churn]
 *        − entry_cost − exit_cost                 [round trip, charged to H]
 *
 * where ℓ(m) is the concentration leverage (amplifies fee share, emission
 * share AND LVR identically), η(m) the expected in-range time fraction, and
 * N_rebal from first-exit-time statistics. The two arms are mutually
 * exclusive on Aerodrome: staked positions earn AERO and forfeit fees.
 *
 * LVR applies to BOTH arms — staked liquidity is still traded against by
 * arbitrageurs; staking changes who gets the fees, not who pays the LVR.
 */

export interface GasContext {
  gasPriceWei: bigint;
  ethUsd: number;
}

export interface OptimizeInput {
  /** Capital budget for this pool; the optimizer chooses size <= budget. */
  budgetUsd: number;
  /** Smallest size worth managing (fixed-cost floor for the size grid). */
  minSizeUsd: number;
  pricing: PoolPricing;
  tickSpacing: number;
  poolFeeFraction: number;
  poolLiquidity: bigint;
  /** null if no USDC in the pair: then 100% of capital must be swapped in. */
  pairHasUsdc: boolean;
  feeRate: FeeRateEstimate | null;
  /** Unstaked in-range liquidity (fee-earning competition). Caps the fee
   *  arm: our fees = pool fee revenue x our share, never rate x L unbounded. */
  unstakedLiquidity: number | null;
  /** AERO/day emitted by the gauge + current staked liquidity. */
  emissions: { aeroPerDayGauge: number; stakedLiquidity: bigint } | null;
  aero: AeroPricing | null;
  vol: VolEstimate;
  cfg: Config;
  gas: GasContext;
  /** When set and equal to $OPT_DEBUG, dumps the top grid cells. */
  debugTag?: string;
}

export interface WidthChoice {
  arm: "fees_unstaked" | "emissions_staked";
  /** Optimizer-chosen position size (USD). For pools with saturating
   *  emissions (thin in-range staked depth vs a fixed reward stream),
   *  the optimum is INTERIOR: more capital adds linear LVR against a
   *  capped reward share. Empirically confirmed on real data. */
  sizeUsd: number;
  widthMult: number;
  leverage: number;
  inRangeFraction: number;
  rebalancesPerHorizon: number;
  grossUsdHorizon: number; // confidence-weighted arm yield
  grossUsdHorizonRaw: number; // before confidence weighting (for reconciliation)
  lvrUsdHorizon: number;
  rebalanceCostUsdHorizon: number;
  entryExitCostUsd: number;
  netUsdHorizon: number;
}

function gasUsd(units: number, gas: GasContext): number {
  return units * Number(gas.gasPriceWei) * 1e-18 * gas.ethUsd;
}

/** Candidate sizes: geometric ladder within [minSize, budget]. */
function sizeGrid(minSize: number, budget: number): number[] {
  if (budget <= minSize) return [budget];
  const out: number[] = [];
  for (let s = minSize; s < budget; s *= 1.6) out.push(Math.round(s));
  out.push(budget);
  return out;
}

export function optimizeWidth(inp: OptimizeInput): WidthChoice | null {
  const { cfg, pricing, vol } = inp;
  const H_DAYS = cfg.scoring.horizon_days;
  const H_YEARS = H_DAYS / 365;
  const sigma = vol.annual;

  // Width grid (log-spaced), floored at one tick spacing.
  const g = cfg.scoring.width_grid;
  const mMin = Math.max(g.min_mult, minWidthForSpacing(inp.tickSpacing));
  if (mMin >= g.max_mult) return null;
  // Geometric in LOG-width: spacing geometric in m itself left the entire
  // ±0.01%..±1% region with one sample point and skipped the profitable
  // tight band on thin-gauge pools entirely. Each grid point is then
  // quantized to a band the pool can actually mint (integer multiples of
  // the tick spacing) — scoring unbuildable widths inflated leverage and
  // lured switches into positions whose realized band was ~2x wider.
  const widthSet = new Set<number>();
  const lnMin = Math.log(mMin);
  const lnMax = Math.log(g.max_mult);
  for (let i = 0; i < g.steps; i++) {
    const raw = Math.exp(lnMin * Math.pow(lnMax / lnMin, i / (g.steps - 1)));
    widthSet.add(quantizeWidth(raw, inp.tickSpacing));
  }
  const widths = [...widthSet];

  const swapFraction = inp.pairHasUsdc ? 0.5 : 1.0;
  const swapCost = (amountUsd: number) =>
    amountUsd *
    (inp.poolFeeFraction + swapImpactFraction(inp.poolLiquidity, pricing, amountUsd));
  const sustainYears = cfg.rebalance.sustain_minutes / (60 * 24 * 365);

  let best: WidthChoice | null = null;
  const debug: { C: number; m: number; net: number; gross: number; lvr: number; reb: number; arm: string }[] = [];
  const debugOn = inp.debugTag !== undefined && process.env.OPT_DEBUG === inp.debugTag;
  for (const C of sizeGrid(inp.minSizeUsd, inp.budgetUsd)) {
  const rebalanceCost =
    gasUsd(cfg.gas.rebalance_gas_units, inp.gas) + swapCost(C / 2);
  const entryExitCost =
    gasUsd(cfg.gas.enter_gas_units + cfg.gas.exit_gas_units, inp.gas) +
    2 * swapCost(swapFraction * C);
  for (const m of widths) {
    const L = liquidityForUsd(pricing, C, m);
    const lev = leverage(m);

    // Exit/recentering statistics, CADENCE-AWARE. Deadband extends the
    // effective band. A real manager checks every check_interval_minutes
    // and recenters at most once per check — so for bands that exit faster
    // than the cadence, the recenter count is capped by the cadence and the
    // position is in range only the first E[T_exit] of each interval
    // (conservative GBM view; realized in-range time has measured higher).
    const mEff = Math.pow(m, 1 + cfg.rebalance.deadband_fraction);
    const exitYears = expectedExitYears(mEff, sigma);
    const checkYears = cfg.rebalance.check_interval_minutes / (60 * 24 * 365);
    let nRebalRaw: number;
    let eta: number;
    if (exitYears === Infinity) {
      nRebalRaw = 0;
      eta = 1;
    } else if (exitYears >= checkYears) {
      nRebalRaw = H_YEARS / exitYears;
      eta = exitYears / (exitYears + sustainYears);
    } else {
      nRebalRaw = H_YEARS / checkYears; // recenter every check, no faster
      eta = exitYears / checkYears; // in range only until first exit
    }

    // A width that needs more recenters than the rate limit allows is
    // infeasible — not discountable (replay-validated: capped rebalances
    // lock in divergence, they don't avoid it).
    const maxRebal = cfg.rebalance.max_rebalances_per_day * H_DAYS;
    if (nRebalRaw > maxRebal) continue;
    const nRebal = nRebalRaw;

    // --- Arm yields over the horizon (gross, in-range weighted) ----------
    const armCandidates: {
      arm: WidthChoice["arm"];
      raw: number;
      weighted: number;
    }[] = [];

    if (inp.feeRate) {
      // Dilution: adding our L grows the divisor of a FIXED revenue stream.
      // Without this, tight-width L on thin pools projected more fees than
      // the whole pool earns (a $920/7d mirage on a $400 position).
      const u = inp.unstakedLiquidity;
      const dilution = u !== null && u > 0 ? u / (u + L) : 1;
      const raw =
        inp.feeRate.usdPerLiquidityPerDay *
        cfg.scoring.fee_persistence *
        L *
        dilution *
        eta *
        H_DAYS;
      armCandidates.push({
        arm: "fees_unstaked",
        raw,
        weighted: raw * cfg.scoring.confidence_fee,
      });
    }
    if (inp.emissions && inp.aero) {
      const share = L / (Number(inp.emissions.stakedLiquidity) + L);
      const aeroPerDayUs = inp.emissions.aeroPerDayGauge * share;
      const lotUsd = realizableAeroUsd(aeroPerDayUs * H_DAYS, inp.aero, cfg);
      const raw = lotUsd * eta;
      armCandidates.push({
        arm: "emissions_staked",
        raw,
        weighted: raw * cfg.scoring.confidence_emissions,
      });
    }
    if (armCandidates.length === 0) return null;
    armCandidates.sort((a, b) => b.weighted - a.weighted);
    const armBest = armCandidates[0]!;

    // --- Costs -------------------------------------------------------------
    // Divergence is NOT discounted by in-range fraction. The old `* eta`
    // assumed you only bleed LVR while in range — but a rate-limited band
    // that exits LOCKS IN the divergence (it converts to the losing side and
    // sits there until the next allowed recenter). Discounting it made tight,
    // fast-exiting, high-emission bands look profitable when they realize
    // losses — the source of the anti-correlated (negative) alpha/predicted
    // ratio in 30d replay. Charge full-horizon divergence.
    const lvr = ((sigma * sigma) / 8) * lev * C * H_YEARS;
    const rebalCost = nRebal * rebalanceCost;
    const net = armBest.weighted - lvr - rebalCost - entryExitCost;
    if (debugOn) debug.push({ C, m, net, gross: armBest.weighted, lvr, reb: rebalCost, arm: armBest.arm });

    if (!best || net > best.netUsdHorizon) {
      best = {
        arm: armBest.arm,
        sizeUsd: C,
        widthMult: m,
        leverage: lev,
        inRangeFraction: eta,
        rebalancesPerHorizon: nRebal,
        grossUsdHorizon: armBest.weighted,
        grossUsdHorizonRaw: armBest.raw,
        lvrUsdHorizon: lvr,
        rebalanceCostUsdHorizon: rebalCost,
        entryExitCostUsd: entryExitCost,
        netUsdHorizon: net,
      };
    }
  }
  }
  if (debugOn) {
    console.log(`  OPT_DEBUG ${inp.debugTag}: ${debug.length} feasible cells; best per size:`);
    const sizes = [...new Set(debug.map((d) => d.C))];
    for (const C of sizes) {
      const bestC = debug.filter((d) => d.C === C).sort((a, b) => b.net - a.net)[0]!;
      console.log(
        `    $${bestC.C} best ±${((bestC.m - 1) * 100).toFixed(2)}% ${bestC.arm}: net $${bestC.net.toFixed(2)}/7d ` +
          `(gross $${bestC.gross.toFixed(2)} − lvr $${bestC.lvr.toFixed(2)} − rebal $${bestC.reb.toFixed(2)})`,
      );
    }
    const tightest = debug.filter((d) => d.m < 1.02).sort((a, b) => b.net - a.net)[0];
    console.log(
      tightest
        ? `    tightest-feasible best: $${tightest.C} ±${((tightest.m - 1) * 100).toFixed(2)}%: net $${tightest.net.toFixed(2)} (gross $${tightest.gross.toFixed(2)} − lvr $${tightest.lvr.toFixed(2)} − rebal $${tightest.reb.toFixed(2)})`
        : `    NO feasible cell tighter than ±2% (rate-limit excludes them at this vol)`,
    );
  }
  return best;
}
