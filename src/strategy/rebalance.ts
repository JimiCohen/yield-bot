import type { Config } from "../config/schema.js";
import type { Store } from "../data/store.js";
import type { AuditLog } from "../audit/log.js";
import {
  liquidityForUsd,
  swapImpactFraction,
  type PoolPricing,
} from "../scoring/clmath.js";
import type { PoolScore } from "../scoring/netYield.js";
import type { PaperCheckResult } from "../monitor/paper.js";
import type { PoolSnapshot } from "../types.js";

/**
 * Rebalancing decision logic — Phase 5.
 *
 * Anti-over-rebalancing is the point of this module, not a feature of it.
 * A rebalance fires only when ALL gates pass; every blocked attempt is
 * audit-logged with the gate that blocked it, because those records (what
 * we didn't do and what it would have cost) are how the thresholds get
 * re-tuned against realized data instead of by feel.
 *
 * Gates, in evaluation order:
 *  1. Trigger      — price beyond the deadband-extended band, SUSTAINED for
 *                    sustain_minutes (clock persisted in range_state, so
 *                    restarts don't reset it). Transient wicks never act.
 *  2. Still-worth-it — the pool must still clear min_net_yield_apr on a
 *                    fresh score; if not, the right move is EXIT, not
 *                    rebalance ("do not stay in marginal pools").
 *  3. Rate limit   — max_rebalances_per_day per position, from the
 *                    persisted rebalance_events history.
 *  4. Net benefit  — projected net yield over the horizon must exceed
 *                    net_benefit_margin x the full cost of moving.
 */

const LN_TICK = Math.log(1.0001);

/** Minimal position view the gate evaluator needs — satisfied by both
 *  paper checks and live (on-chain NFT) checks. */
export interface RangeCheck {
  inRange: boolean;
  beyondDeadband: boolean;
  valueUsd: number;
  /** position age in ms; exits/switches blocked under min_hold_minutes */
  ageMs?: number;
}

export interface RebalanceDecision {
  action: "hold" | "rebalance" | "exit" | "blocked";
  reasons: string[];
  costUsd: number | null;
  projectedNetUsdH: number | null;
}

export function rebalanceCostUsd(
  cfg: Config,
  snap: PoolSnapshot,
  pricing: PoolPricing,
  positionValueUsd: number,
  gas: { gasPriceWei: bigint; ethUsd: number },
): number {
  const gasUsd = cfg.gas.rebalance_gas_units * Number(gas.gasPriceWei) * 1e-18 * gas.ethUsd;
  // Recentering swaps ~half the position (it is one-sided once out of range).
  const swapAmount = positionValueUsd / 2;
  const swapCost =
    swapAmount *
    ((snap.feePips ?? 0) / 1e6 + swapImpactFraction(snap.liquidity, pricing, swapAmount));
  return gasUsd + swapCost;
}

export function evaluateRebalance(
  cfg: Config,
  store: Store,
  positionKey: string,
  check: RangeCheck,
  freshScore: PoolScore | null,
  snap: PoolSnapshot,
  pricing: PoolPricing,
  gas: { gasPriceWei: bigint; ethUsd: number },
): RebalanceDecision {
  // Gate 2 first when it implies exit: a pool that no longer clears the
  // yield floor should be left regardless of range state.
  const freshApr =
    freshScore?.choice && freshScore.choice.netUsdHorizon > 0
      ? (freshScore.choice.netUsdHorizon / freshScore.positionUsd) *
        (365 / cfg.scoring.horizon_days) *
        100
      : null;
  // Entry/exit hysteresis: exiting requires falling WELL below the entry
  // bar (half of it), not just under it — entering at bar+0.5% and exiting
  // at bar−1% an hour later is threshold churn, paid in round-trip costs.
  // (Observed on the first live paper round-trip: in at 8.5%, out at 6.9%.)
  const exitBar = cfg.scoring.min_net_yield_apr * 0.5;
  const underMinHold =
    check.ageMs !== undefined && check.ageMs < cfg.rebalance.min_hold_minutes * 60_000;
  const stillWorthHolding =
    underMinHold || (freshApr !== null && freshApr >= exitBar);
  if (!stillWorthHolding) {
    return {
      action: "exit",
      reasons: [
        freshScore?.choice
          ? `BELOW_EXIT_BAR (fresh ${freshApr === null ? "<=0" : freshApr.toFixed(1) + "%"} < ${exitBar}% exit bar; entry bar ${cfg.scoring.min_net_yield_apr}%)`
          : "POOL_NO_LONGER_SCORABLE",
      ],
      costUsd: null,
      projectedNetUsdH: freshScore?.choice?.netUsdHorizon ?? null,
    };
  }

  // Gate 1: trigger — in range and inside deadband means nothing to do.
  if (check.inRange && !check.beyondDeadband) {
    return { action: "hold", reasons: ["IN_RANGE"], costUsd: null, projectedNetUsdH: null };
  }
  const state = store.getRangeState(positionKey);
  if (state.beyondDeadbandSince === null) {
    return {
      action: "blocked",
      reasons: ["DEADBAND (out of range but within deadband buffer)"],
      costUsd: null,
      projectedNetUsdH: null,
    };
  }
  const sustainedMin = (Date.now() - state.beyondDeadbandSince) / 60_000;
  if (sustainedMin < cfg.rebalance.sustain_minutes) {
    return {
      action: "blocked",
      reasons: [
        `SUSTAIN (beyond deadband ${sustainedMin.toFixed(0)}min < ${cfg.rebalance.sustain_minutes}min)`,
      ],
      costUsd: null,
      projectedNetUsdH: null,
    };
  }

  // Gate 3: rate limit.
  const recent = store.countRecentRebalances(positionKey, 24 * 3600 * 1000);
  if (recent >= cfg.rebalance.max_rebalances_per_day) {
    return {
      action: "blocked",
      reasons: [`RATE_LIMIT (${recent}/${cfg.rebalance.max_rebalances_per_day} in 24h)`],
      costUsd: null,
      projectedNetUsdH: null,
    };
  }

  // Gate 4: net benefit with margin.
  const cost = rebalanceCostUsd(cfg, snap, pricing, check.valueUsd, gas);
  const projected = freshScore!.choice!.netUsdHorizon;
  if (projected < cfg.rebalance.net_benefit_margin * cost) {
    return {
      action: "blocked",
      reasons: [
        `NET_BENEFIT ($${projected.toFixed(2)}/${cfg.scoring.horizon_days}d < ${cfg.rebalance.net_benefit_margin}x $${cost.toFixed(2)} cost)`,
      ],
      costUsd: cost,
      projectedNetUsdH: projected,
    };
  }

  return {
    action: "rebalance",
    reasons: [
      `ALL_GATES_PASS (sustained ${sustainedMin.toFixed(0)}min, ${recent}/${cfg.rebalance.max_rebalances_per_day} rebal used, ` +
        `$${projected.toFixed(2)} >= ${cfg.rebalance.net_benefit_margin}x $${cost.toFixed(2)})`,
    ],
    costUsd: cost,
    projectedNetUsdH: projected,
  };
}

/**
 * Apply a passed-gates rebalance to a paper position: recenter at the
 * current tick with the freshly optimized width, charge the full move cost,
 * reset the hysteresis clocks, and record the event for the rate limiter.
 */
export function executePaperRebalance(
  cfg: Config,
  store: Store,
  audit: AuditLog,
  check: PaperCheckResult,
  freshScore: PoolScore,
  snap: PoolSnapshot,
  pricing: PoolPricing,
  costUsd: number,
): { tickLower: number; tickUpper: number; widthMult: number } {
  const p = check.position;
  const widthMult = freshScore.choice!.widthMult; // width recalculated, not reused
  const halfWidthTicks = Math.log(widthMult) / LN_TICK;
  const snapTick = (t: number) => Math.round(t / p.tickSpacing) * p.tickSpacing;
  let tickLower = snapTick(snap.tick - halfWidthTicks);
  let tickUpper = snapTick(snap.tick + halfWidthTicks);
  if (tickUpper <= tickLower) tickUpper = tickLower + p.tickSpacing;

  const redeployUsd = Math.max(0, check.valueUsd - costUsd);
  const newL = liquidityForUsd(pricing, redeployUsd, widthMult);

  store.applyPaperRebalance(p.id, {
    tickLower,
    tickUpper,
    widthMult,
    liquidity: newL,
    extraCostsUsd: p.extraCostsUsd + costUsd,
    rebalances: p.rebalances + 1,
    lastTick: snap.tick,
  });
  store.recordRebalanceEvent({
    positionKey: `paper:${p.id}`,
    costUsd,
    oldLower: p.tickLower,
    oldUpper: p.tickUpper,
    newLower: tickLower,
    newUpper: tickUpper,
  });
  store.setRangeState(`paper:${p.id}`, null, null, snap.tick); // back in range
  audit.record("paper_rebalance", p.pool, "REBALANCED", {
    id: p.id,
    pair: p.pair,
    oldBand: [p.tickLower, p.tickUpper],
    newBand: [tickLower, tickUpper],
    widthMult,
    costUsd,
    redeployUsd,
    projectedNetUsdH: freshScore.choice!.netUsdHorizon,
  });
  return { tickLower, tickUpper, widthMult };
}
