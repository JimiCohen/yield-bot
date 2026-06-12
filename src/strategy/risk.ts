import type { Config } from "../config/schema.js";
import type { Store } from "../data/store.js";

/**
 * Risk triggers — Phase 7. Any tripped trigger means EXIT NOW, bypassing
 * the rebalance gates entirely (fast-withdrawal posture). Triggers are
 * deliberately independent of the yield model: they fire on conditions
 * under which the model's assumptions are void.
 *
 * Depeg detection uses DeFiLlama's price API as an INDEPENDENT advisory
 * source. This is a deliberate exception to "on-chain canonical": detecting
 * a USDC depeg from pools priced in USDC is circular — a depeg check needs
 * a reference frame outside the thing being checked. If the advisory source
 * is down, the check degrades to "no signal" and reports itself as such; it
 * never blocks operation.
 */

export interface RiskCheckResult {
  triggers: string[]; // non-empty => exit posture
  degraded: string[]; // checks that could not run
}

interface LlamaPrices {
  usdc: number | null;
  cbbtc: number | null;
  btcRef: number | null;
}

export async function fetchAdvisoryPrices(cfg: Config): Promise<LlamaPrices | null> {
  try {
    const usdcAddr = cfg.allowlist.tokens["USDC"]!.address.toLowerCase();
    const cbbtcAddr = cfg.allowlist.tokens["cbBTC"]?.address.toLowerCase();
    const keys = [
      `base:${usdcAddr}`,
      ...(cbbtcAddr ? [`base:${cbbtcAddr}`] : []),
      "coingecko:bitcoin",
    ].join(",");
    const res = await fetch(`https://coins.llama.fi/prices/current/${keys}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      coins: Record<string, { price?: number }>;
    };
    return {
      usdc: body.coins[`base:${usdcAddr}`]?.price ?? null,
      cbbtc: cbbtcAddr ? (body.coins[`base:${cbbtcAddr}`]?.price ?? null) : null,
      btcRef: body.coins["coingecko:bitcoin"]?.price ?? null,
    };
  } catch {
    return null;
  }
}

export async function checkRiskTriggers(
  cfg: Config,
  store: Store,
  pool: string,
  pair: string,
  currentTvlUsdc: number,
  currentVolAnnual: number | null,
): Promise<RiskCheckResult> {
  const triggers: string[] = [];
  const degraded: string[] = [];

  // --- depeg watch (advisory source, independent reference frame) --------
  const prices = await fetchAdvisoryPrices(cfg);
  if (!prices) {
    degraded.push("DEPEG_CHECK_UNAVAILABLE (advisory price source down)");
  } else {
    if (prices.usdc !== null && prices.usdc < cfg.risk.usdc_depeg_exit) {
      triggers.push(`USDC_DEPEG (advisory $${prices.usdc.toFixed(4)} < ${cfg.risk.usdc_depeg_exit})`);
    }
    if (prices.cbbtc !== null && prices.btcRef !== null && prices.btcRef > 0) {
      const basisBps = Math.abs(prices.cbbtc / prices.btcRef - 1) * 10_000;
      if (basisBps > cfg.risk.cbbtc_basis_exit_bps) {
        triggers.push(
          `CBBTC_BASIS (${basisBps.toFixed(0)}bps vs BTC > ${cfg.risk.cbbtc_basis_exit_bps}bps)`,
        );
      }
    }
  }

  // --- TVL collapse (own snapshot history; on-chain sourced) --------------
  const peak = store.getPeakTvl(pool, cfg.risk.tvl_collapse_window_hours * 3600 * 1000);
  if (peak === null) {
    degraded.push("TVL_HISTORY_SHORT");
  } else if (currentTvlUsdc < (1 - cfg.risk.tvl_collapse_fraction) * peak) {
    triggers.push(
      `TVL_COLLAPSE ($${Math.round(currentTvlUsdc).toLocaleString()} < ${((1 - cfg.risk.tvl_collapse_fraction) * 100).toFixed(0)}% of ${cfg.risk.tvl_collapse_window_hours}h peak $${Math.round(peak).toLocaleString()})`,
    );
  }

  // --- volatility spike ----------------------------------------------------
  if (currentVolAnnual !== null) {
    const prior =
      cfg.volatility.fallback_annual[pair] ?? cfg.volatility.fallback_default;
    if (currentVolAnnual > cfg.risk.vol_spike_multiple * prior) {
      triggers.push(
        `VOL_SPIKE (${(currentVolAnnual * 100).toFixed(0)}% > ${cfg.risk.vol_spike_multiple}x ${(prior * 100).toFixed(0)}% prior)`,
      );
    }
  }

  return { triggers, degraded };
}
