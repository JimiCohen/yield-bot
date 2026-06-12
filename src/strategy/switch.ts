import type { Config } from "../config/schema.js";
import { swapImpactFraction, type PoolPricing } from "../scoring/clmath.js";
import type { PoolScore } from "../scoring/netYield.js";
import type { PoolSnapshot } from "../types.js";

/**
 * Cross-pool switching — Phase 6.
 *
 * A switch pays the FULL round trip: exit the current pool (gas + swap back
 * to entry shape) plus enter the new one (gas + swap to its ratio). The
 * advantage must exceed switch_margin x that round trip — a stricter margin
 * than rebalancing (default 4x vs 3x) because a switch realizes the current
 * position's state AND takes on fresh entry risk in one move, and because
 * NEY estimates of two different pools differ more than two estimates of
 * the same pool.
 *
 * Anti-thrash: the advantage is computed against the CURRENT pool's fresh
 * score; if the current pool is no longer scorable the rebalance stack's
 * exit path handles it first — switching never doubles as an exit decision.
 */

export interface SwitchDecision {
  action: "stay" | "switch";
  target: PoolScore | null;
  advantageUsdH: number | null;
  roundTripCostUsd: number | null;
  reasons: string[];
}

function swapLegCostUsd(
  snap: PoolSnapshot,
  pricing: PoolPricing,
  valueUsd: number,
  pairHasUsdc: boolean,
): number {
  const amount = (pairHasUsdc ? 0.5 : 1.0) * valueUsd;
  return (
    amount *
    ((snap.feePips ?? 0) / 1e6 + swapImpactFraction(snap.liquidity, pricing, amount))
  );
}

export function evaluateSwitch(
  cfg: Config,
  current: { pool: string; pair: string; valueUsd: number },
  currentScore: PoolScore | null,
  candidates: PoolScore[], // viable, sorted by NEY desc
  pricingFor: (s: PoolScore) => PoolPricing | null,
  currentPricing: PoolPricing,
  currentSnap: PoolSnapshot,
  gas: { gasPriceWei: bigint; ethUsd: number },
): SwitchDecision {
  const best = candidates.find(
    (s) => s.snapshot.pool.toLowerCase() !== current.pool.toLowerCase(),
  );
  if (!best || !best.choice) {
    return { action: "stay", target: null, advantageUsdH: null, roundTripCostUsd: null, reasons: ["NO_ALTERNATIVE"] };
  }
  const bestPricing = pricingFor(best);
  if (!bestPricing) {
    return { action: "stay", target: null, advantageUsdH: null, roundTripCostUsd: null, reasons: ["NO_TARGET_PRICING"] };
  }

  const gasUsd =
    (cfg.gas.exit_gas_units + cfg.gas.enter_gas_units) *
    Number(gas.gasPriceWei) *
    1e-18 *
    gas.ethUsd;
  const [cs0, cs1] = current.pair.split("/") as [string, string];
  const exitLeg = swapLegCostUsd(
    currentSnap,
    currentPricing,
    current.valueUsd,
    cs0 === "USDC" || cs1 === "USDC",
  );
  const enterLeg = swapLegCostUsd(
    best.snapshot,
    bestPricing,
    current.valueUsd,
    best.snapshot.symbol0 === "USDC" || best.snapshot.symbol1 === "USDC",
  );
  const roundTrip = gasUsd + exitLeg + enterLeg;

  const currentNet = currentScore?.choice?.netUsdHorizon ?? 0;
  const advantage = best.choice.netUsdHorizon - currentNet;
  if (advantage < cfg.rebalance.switch_margin * roundTrip) {
    return {
      action: "stay",
      target: best,
      advantageUsdH: advantage,
      roundTripCostUsd: roundTrip,
      reasons: [
        `SWITCH_MARGIN ($${advantage.toFixed(2)}/${cfg.scoring.horizon_days}d advantage < ${cfg.rebalance.switch_margin}x $${roundTrip.toFixed(2)} round trip)`,
      ],
    };
  }
  return {
    action: "switch",
    target: best,
    advantageUsdH: advantage,
    roundTripCostUsd: roundTrip,
    reasons: [
      `SWITCH (${best.snapshot.pair} advantage $${advantage.toFixed(2)}/${cfg.scoring.horizon_days}d >= ${cfg.rebalance.switch_margin}x $${roundTrip.toFixed(2)})`,
    ],
  };
}
