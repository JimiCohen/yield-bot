import type { ChainClient } from "../chain/client.js";
import type { Config } from "../config/schema.js";
import type { Store } from "../data/store.js";
import type { PoolSnapshot } from "../types.js";
import type { PoolPricing } from "./clmath.js";
import { estimateFeeRate } from "./fees.js";
import { estimateVolatility } from "./volatility.js";
import { discoverAeroPricing, type AeroPricing } from "./emissions.js";
import { optimizeWidth, type GasContext, type WidthChoice } from "./optimizer.js";

/**
 * Net Expected Yield orchestration: for each eligible pool, gather the
 * on-chain inputs (fee rate, vol, emissions, gas), run the width optimizer
 * over both yield arms, and reconcile against advisory APY.
 *
 * Reconciliation policy (both directions):
 *  - Advisory APY >> what on-chain data supports  => "unreconciled outlier";
 *    informational only — we never allocate off advisory numbers anyway.
 *  - OUR gross >> advisory APY                    => "suspect" — likely a
 *    short fee window catching a volume spike; confidence is halved rather
 *    than trusted.
 */

export interface PoolScore {
  snapshot: PoolSnapshot;
  positionUsd: number;
  choice: WidthChoice | null;
  volAnnual: number;
  volSource: string;
  volConfidence: string;
  feeWindowHours: number | null;
  feeConfidence: string | null;
  aeroSpotUsd: number | null;
  onchainGrossAprPct: number | null;
  llamaApyPct: number | null;
  flags: string[];
  neyAprPct: number | null;
}

export interface ScoreRunResult {
  scores: PoolScore[];
  aero: AeroPricing | null;
  gas: GasContext;
}

/** Per-pool capital BUDGET (ceiling). The optimizer picks the
 *  profit-maximizing size at or below this — size is an output of the
 *  model now, not an input. */
export function positionSizeUsd(cfg: Config): number {
  const capped = cfg.capital_usdc * cfg.position.max_pool_fraction;
  return Math.min(cfg.capital_usdc, Math.max(capped, cfg.position.min_position_usd));
}

/** The allocation filter: positive NEY, clears the minimum APR floor, and
 *  reconciles against advisory data. Used by entry, auto-open and switch
 *  targeting so all three share one definition of "worth holding". */
export function viableScores(
  scores: PoolScore[],
  cfg: Config,
  isRegimeFavorable?: (pair: string) => boolean,
): PoolScore[] {
  return scores.filter(
    (s) =>
      s.choice &&
      s.choice.netUsdHorizon > 0 &&
      (s.neyAprPct ?? -1) >= cfg.scoring.min_net_yield_apr &&
      !s.flags.includes("ADVISORY_APY_UNRECONCILED") &&
      // Emission-regime gate: skip pools whose emissions have faded below
      // their baseline. Pure/optional so callers without regime data behave
      // exactly as before.
      (!isRegimeFavorable || isRegimeFavorable(s.snapshot.pair)),
  );
}

export async function scorePools(
  cfg: Config,
  client: ChainClient,
  store: Store,
  snapshots: PoolSnapshot[],
  pricesUsd: Record<string, number>,
  blockNow: bigint,
): Promise<ScoreRunResult> {
  const eligible = snapshots.filter((s) => s.eligible);
  const ethUsd = pricesUsd["WETH"];
  if (!ethUsd) throw new Error("No WETH/USDC price available — cannot price gas");
  const gas: GasContext = {
    gasPriceWei: await client.getGasPrice(),
    ethUsd,
  };
  const aero = await discoverAeroPricing(client, cfg);
  const budgetUsd = positionSizeUsd(cfg);

  const scores: PoolScore[] = [];
  for (const s of eligible) {
    const p0Usd = pricesUsd[s.symbol0];
    const p1Usd = pricesUsd[s.symbol1];
    if (p0Usd === undefined || p1Usd === undefined) continue;
    const dec0 = cfg.allowlist.tokens[s.symbol0]!.decimals;
    const dec1 = cfg.allowlist.tokens[s.symbol1]!.decimals;
    const pricing: PoolPricing = {
      sqrtPriceX96: s.sqrtPriceX96,
      dec0,
      dec1,
      p0Usd,
      p1Usd,
    };

    const flags: string[] = [];
    const [feeRate, vol] = await Promise.all([
      estimateFeeRate(client, s.pool, blockNow, pricing),
      estimateVolatility(client, store, cfg, s.pool, s.pair, s.tick, blockNow),
    ]);
    if (!feeRate) flags.push("NO_FEE_HISTORY");
    else if (feeRate.windowHours < 24) flags.push(`FEE_WINDOW_${feeRate.windowHours}H`);
    if (vol.source === "fallback") flags.push("VOL_FALLBACK");
    // Floor measured vol at the config prior: calm-spell EWMA readings
    // license tight widths right before vol expands (backtest-validated).
    const volFloor =
      cfg.volatility.fallback_annual[s.pair] ?? cfg.volatility.fallback_default;
    if (vol.annual < volFloor) {
      vol.annual = volFloor;
      flags.push("VOL_FLOORED");
    }
    if (!aero) flags.push("NO_AERO_PRICING");

    const emissions =
      s.rewardRate !== null && s.stakedLiquidity !== null && s.gaugeAlive
        ? {
            aeroPerDayGauge: (Number(s.rewardRate) / 1e18) * 86400,
            stakedLiquidity: s.stakedLiquidity,
          }
        : null;

    const choice = optimizeWidth({
      budgetUsd,
      minSizeUsd: cfg.position.min_position_usd,
      pricing,
      tickSpacing: s.tickSpacing,
      poolFeeFraction: (s.feePips ?? 0) / 1e6,
      poolLiquidity: s.liquidity,
      pairHasUsdc: s.symbol0 === "USDC" || s.symbol1 === "USDC",
      feeRate,
      unstakedLiquidity:
        s.stakedLiquidity !== null ? Number(s.liquidity - s.stakedLiquidity) : null,
      emissions,
      aero,
      vol,
      cfg,
      gas,
      debugTag: s.pool.toLowerCase(),
    });

    // --- Reconciliation vs advisory APY ----------------------------------
    const positionUsd = choice?.sizeUsd ?? budgetUsd;
    let onchainGrossAprPct: number | null = null;
    if (choice) {
      onchainGrossAprPct =
        ((choice.grossUsdHorizonRaw / positionUsd) * (365 / cfg.scoring.horizon_days)) * 100;
      if (s.llamaApy !== null && onchainGrossAprPct > 0) {
        if (s.llamaApy > cfg.scoring.outlier_ratio * onchainGrossAprPct && s.llamaApy > 30) {
          flags.push("ADVISORY_APY_UNRECONCILED");
        }
        if (onchainGrossAprPct > cfg.scoring.outlier_ratio * s.llamaApy) {
          flags.push("ONCHAIN_GROSS_SUSPECT");
          // Halve the gross & net rather than trust a possible window fluke.
          choice.grossUsdHorizon *= 0.5;
          choice.netUsdHorizon -= choice.grossUsdHorizon;
        }
      }
    }

    scores.push({
      snapshot: s,
      positionUsd,
      choice,
      volAnnual: vol.annual,
      volSource: vol.source,
      volConfidence: vol.confidence,
      feeWindowHours: feeRate?.windowHours ?? null,
      feeConfidence: feeRate?.confidence ?? null,
      aeroSpotUsd: aero?.spotUsd ?? null,
      onchainGrossAprPct,
      llamaApyPct: s.llamaApy,
      flags,
      neyAprPct: choice
        ? ((choice.netUsdHorizon / positionUsd) * (365 / cfg.scoring.horizon_days)) * 100
        : null,
    });
  }

  scores.sort(
    (a, b) => (b.choice?.netUsdHorizon ?? -Infinity) - (a.choice?.netUsdHorizon ?? -Infinity),
  );
  return { scores, aero, gas };
}
