import type { ChainClient } from "../chain/client.js";
import { clGaugeAbi, clPoolAbi } from "../chain/abis.js";
import type { Config } from "../config/schema.js";
import type { Store, PaperPositionRow } from "../data/store.js";
import type { AuditLog } from "../audit/log.js";
import {
  liquidityForUsd,
  positionValueUsd,
  sRaw,
  swapImpactFraction,
  type PoolPricing,
} from "../scoring/clmath.js";
import type { PoolScore } from "../scoring/netYield.js";
import type { AeroPricing } from "../scoring/emissions.js";
import type { PoolSnapshot } from "../types.js";

/**
 * Paper position lifecycle. The shadow portfolio is marked against REAL
 * on-chain deltas — actual feeGrowthGlobal growth, actual gauge rewardRate,
 * actual AERO price — so closed paper entries are legitimate
 * predicted-vs-realized data for model validation, not simulations of
 * simulations. Entry/exit costs are charged exactly as live execution would
 * pay them (gas at current price + swap fee + size-aware impact).
 */

const LN_TICK = Math.log(1.0001);

export interface PaperCheckResult {
  position: PaperPositionRow;
  inRange: boolean;
  tickNow: number;
  valueUsd: number;
  /** distance from current tick to nearest band edge, in % of price */
  edgeDistancePct: number;
  beyondDeadband: boolean;
  sustainedOutMinutes: number | null;
  feesUsd: number;
  pendingAeroUsd: number;
}

function tickToSqrtRaw(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

export function openPaperPosition(
  cfg: Config,
  store: Store,
  audit: AuditLog,
  top: PoolScore,
  blockNumber: bigint,
  gas: { gasPriceWei: bigint; ethUsd: number },
  pricesUsd: Record<string, number>,
): number {
  const s = top.snapshot;
  const choice = top.choice;
  if (!choice) throw new Error("score has no width choice");
  const dec0 = cfg.allowlist.tokens[s.symbol0]!.decimals;
  const dec1 = cfg.allowlist.tokens[s.symbol1]!.decimals;
  const pricing: PoolPricing = {
    sqrtPriceX96: s.sqrtPriceX96,
    dec0,
    dec1,
    p0Usd: pricesUsd[s.symbol0]!,
    p1Usd: pricesUsd[s.symbol1]!,
  };

  const gasUsd =
    (cfg.gas.enter_gas_units * Number(gas.gasPriceWei) * 1e-18) * gas.ethUsd;
  const swapFraction = s.symbol0 === "USDC" || s.symbol1 === "USDC" ? 0.5 : 1.0;
  const swapAmount = swapFraction * top.positionUsd;
  const swapCost =
    swapAmount *
    ((s.feePips ?? 0) / 1e6 + swapImpactFraction(s.liquidity, pricing, swapAmount));
  const entryCost = gasUsd + swapCost;
  const deployed = top.positionUsd - entryCost;

  const L = liquidityForUsd(pricing, deployed, choice.widthMult);
  const sNow = sRaw(s.sqrtPriceX96);

  // Snap band to tick spacing (live execution must; paper mirrors it).
  const halfWidthTicks = Math.log(choice.widthMult) / LN_TICK;
  const snap = (t: number) => Math.round(t / s.tickSpacing) * s.tickSpacing;
  let tickLower = snap(s.tick - halfWidthTicks);
  let tickUpper = snap(s.tick + halfWidthTicks);
  if (tickUpper <= tickLower) tickUpper = tickLower + s.tickSpacing;
  const sa = tickToSqrtRaw(tickLower);
  const sb = tickToSqrtRaw(tickUpper);

  const id = store.openPaperPosition({
    openedTs: Date.now(),
    openedBlock: Number(blockNumber),
    pool: s.pool,
    pair: s.pair,
    tickSpacing: s.tickSpacing,
    arm: choice.arm,
    widthMult: choice.widthMult,
    tickLower,
    tickUpper,
    liquidity: L,
    entryValueUsd: deployed,
    entryAmt0: L * (1 / Math.min(Math.max(sNow, sa), sb) - 1 / sb),
    entryAmt1: L * (Math.min(Math.max(sNow, sa), sb) - sa),
    entryCostsUsd: entryCost,
    predictedNetUsdH: choice.netUsdHorizon,
    positionUsd: top.positionUsd,
    lastFg0: 0n, // filled on first check
    lastFg1: 0n,
    lastTick: s.tick,
  });
  audit.record("paper_open", s.pool, "OPENED", {
    id,
    pair: s.pair,
    arm: choice.arm,
    widthMult: choice.widthMult,
    tickLower,
    tickUpper,
    positionUsd: top.positionUsd,
    entryCost,
    predictedNetUsdH: choice.netUsdHorizon,
  });
  return id;
}

/** Accrue real on-chain deltas since last check; update hysteresis state. */
export async function checkPaperPosition(
  cfg: Config,
  client: ChainClient,
  store: Store,
  p: PaperPositionRow,
  snapshots: PoolSnapshot[],
  pricesUsd: Record<string, number>,
  aero: AeroPricing | null,
): Promise<PaperCheckResult> {
  const snap = snapshots.find((s) => s.pool.toLowerCase() === p.pool.toLowerCase());
  if (!snap) throw new Error(`pool ${p.pool} missing from scan`);
  const [sym0, sym1] = p.pair.split("/") as [string, string];
  const dec0 = cfg.allowlist.tokens[sym0]!.decimals;
  const dec1 = cfg.allowlist.tokens[sym1]!.decimals;
  const pricing: PoolPricing = {
    sqrtPriceX96: snap.sqrtPriceX96,
    dec0,
    dec1,
    p0Usd: pricesUsd[sym0]!,
    p1Usd: pricesUsd[sym1]!,
  };

  // Fresh fee growth + gauge state (one multicall).
  const reads = (await client.multicall({
    contracts: [
      { address: p.pool as `0x${string}`, abi: clPoolAbi, functionName: "feeGrowthGlobal0X128" },
      { address: p.pool as `0x${string}`, abi: clPoolAbi, functionName: "feeGrowthGlobal1X128" },
      ...(snap.gauge
        ? [{ address: snap.gauge, abi: clGaugeAbi, functionName: "periodFinish" as const }]
        : []),
    ] as never,
    allowFailure: true,
  })) as { status: string; result?: unknown }[];
  const fg0 = reads[0]?.status === "success" ? (reads[0].result as bigint) : p.lastFg0;
  const fg1 = reads[1]?.status === "success" ? (reads[1].result as bigint) : p.lastFg1;
  const periodFinish =
    snap.gauge && reads[2]?.status === "success" ? Number(reads[2].result as bigint) : 0;

  const tickNow = snap.tick;
  const inPrev = p.lastTick >= p.tickLower && p.lastTick < p.tickUpper;
  const inNow = tickNow >= p.tickLower && tickNow < p.tickUpper;
  const inFrac = inPrev && inNow ? 1 : inPrev || inNow ? 0.5 : 0;

  let feesUsd = p.feesUsd;
  let pendingAero = p.pendingAero;
  const firstCheck = p.lastFg0 === 0n && p.lastFg1 === 0n;
  if (!firstCheck && inFrac > 0) {
    if (p.arm === "fees_unstaked") {
      const d0 = Number(fg0 - p.lastFg0) / 2 ** 128;
      const d1 = Number(fg1 - p.lastFg1) / 2 ** 128;
      feesUsd +=
        (d0 * (pricing.p0Usd / 10 ** dec0) + d1 * (pricing.p1Usd / 10 ** dec1)) *
        p.liquidity *
        inFrac;
    } else if (
      snap.rewardRate !== null &&
      snap.stakedLiquidity !== null &&
      periodFinish > Date.now() / 1000
    ) {
      const dtSec = (Date.now() - p.lastCheckTs) / 1000;
      const share = p.liquidity / (Number(snap.stakedLiquidity) + p.liquidity);
      pendingAero += (Number(snap.rewardRate) / 1e18) * dtSec * share * inFrac;
    }
  }
  store.updatePaperAccrual(p.id, {
    feesUsd,
    pendingAero,
    lastCheckTs: Date.now(),
    lastFg0: fg0,
    lastFg1: fg1,
    lastTick: tickNow,
  });

  // Hysteresis state (persisted; Phase 5 consumes this).
  const key = `paper:${p.id}`;
  const prev = store.getRangeState(key);
  const center = (p.tickLower + p.tickUpper) / 2;
  const halfWidthTicks = (p.tickUpper - p.tickLower) / 2;
  const beyondDeadband =
    Math.abs(tickNow - center) > halfWidthTicks * (1 + cfg.rebalance.deadband_fraction);
  const outSince = inNow ? null : (prev.outSince ?? Date.now());
  const beyondSince = beyondDeadband ? (prev.beyondDeadbandSince ?? Date.now()) : null;
  store.setRangeState(key, outSince, beyondSince, tickNow);

  const sNow = sRaw(snap.sqrtPriceX96);
  const valueUsd = positionValueUsd(
    p.liquidity,
    tickToSqrtRaw(p.tickLower),
    tickToSqrtRaw(p.tickUpper),
    sNow,
    pricing,
  );
  const edgeTicks = Math.min(
    Math.abs(tickNow - p.tickLower),
    Math.abs(p.tickUpper - tickNow),
  );
  const pendingAeroUsd = aero ? pendingAero * aero.spotUsd * (1 - aero.poolFeeFraction) : 0;

  return {
    position: { ...p, feesUsd, pendingAero, lastTick: tickNow },
    inRange: inNow,
    tickNow,
    valueUsd,
    edgeDistancePct: (inNow ? 1 : -1) * (Math.expm1(edgeTicks * LN_TICK)) * 100,
    beyondDeadband,
    sustainedOutMinutes: outSince ? (Date.now() - outSince) / 60000 : null,
    feesUsd,
    pendingAeroUsd,
  };
}

/** Close: realize value + accruals − exit costs; write the ledger entry. */
export function closePaperPosition(
  cfg: Config,
  store: Store,
  audit: AuditLog,
  check: PaperCheckResult,
  snap: PoolSnapshot,
  pricesUsd: Record<string, number>,
  gas: { gasPriceWei: bigint; ethUsd: number },
  reason: string,
): { realizedNetUsd: number; realizedAlphaUsdH: number } {
  const p = check.position;
  const [sym0, sym1] = p.pair.split("/") as [string, string];
  const dec0 = cfg.allowlist.tokens[sym0]!.decimals;
  const dec1 = cfg.allowlist.tokens[sym1]!.decimals;
  const pricing: PoolPricing = {
    sqrtPriceX96: snap.sqrtPriceX96,
    dec0,
    dec1,
    p0Usd: pricesUsd[sym0]!,
    p1Usd: pricesUsd[sym1]!,
  };
  const gasUsd = cfg.gas.exit_gas_units * Number(gas.gasPriceWei) * 1e-18 * gas.ethUsd;
  const swapFraction = sym0 === "USDC" || sym1 === "USDC" ? 0.5 : 1.0;
  const swapAmount = swapFraction * check.valueUsd;
  const exitCost =
    gasUsd +
    swapAmount *
      ((snap.feePips ?? 0) / 1e6 + swapImpactFraction(snap.liquidity, pricing, swapAmount));

  const proceeds = check.valueUsd + check.feesUsd + check.pendingAeroUsd - exitCost;
  const realizedNetUsd = proceeds - p.positionUsd;
  const hodlUsd =
    p.entryAmt0 * (pricing.p0Usd / 10 ** dec0) + p.entryAmt1 * (pricing.p1Usd / 10 ** dec1);
  const alpha = proceeds - hodlUsd - (p.positionUsd - p.entryValueUsd);
  const daysHeld = Math.max(1 / 24, (Date.now() - p.openedTs) / 86_400_000);
  const realizedAlphaUsdH = (alpha / daysHeld) * cfg.scoring.horizon_days;

  store.closePaperPosition(p.id, {
    exitTs: Date.now(),
    daysHeld,
    realizedAlphaUsdH,
    realizedNetUsd,
    feesUsd: check.feesUsd,
    emissionsUsd: check.pendingAeroUsd,
    // extraCostsUsd (rebalances) is already reflected in position value via
    // reduced L; included here for cost REPORTING only.
    costsUsd: p.entryCostsUsd + p.extraCostsUsd + exitCost,
  });
  audit.record("paper_close", p.pool, "CLOSED", {
    id: p.id,
    pair: p.pair,
    reason,
    daysHeld,
    realizedNetUsd,
    realizedAlphaUsdH,
    predictedNetUsdH: p.predictedNetUsdH,
    feesUsd: check.feesUsd,
    emissionsUsd: check.pendingAeroUsd,
  });
  return { realizedNetUsd, realizedAlphaUsdH };
}
