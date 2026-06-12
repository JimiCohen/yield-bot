import type { ChainClient } from "../chain/client.js";
import { clPoolAbi } from "../chain/abis.js";
import type { PoolPricing } from "./clmath.js";

/**
 * Empirical fee rate for an UNSTAKED LP, measured from on-chain
 * feeGrowthGlobal deltas over a trailing window.
 *
 * feeGrowthGlobal{0,1}X128 is cumulative fees per unit of liquidity, so the
 * delta over a window is exactly what one liquidity unit earned — no volume
 * estimates, no third-party APIs. This is the HIGH-confidence yield arm.
 *
 * Window ladder: prefer 24h (smooths intraday lulls/spikes); public RPCs
 * that won't serve old state degrade to 6h then 1h, with confidence marked
 * down accordingly — a 1h window is a weather report, not a climate average.
 */

const BLOCKS_PER_HOUR = 1800; // Base ~2s block time

export interface FeeRateEstimate {
  usdPerLiquidityPerDay: number;
  windowHours: number;
  confidence: "high" | "medium" | "low";
}

export async function estimateFeeRate(
  client: ChainClient,
  pool: `0x${string}`,
  blockNow: bigint,
  pricing: PoolPricing,
): Promise<FeeRateEstimate | null> {
  const readBoth = async (blockNumber?: bigint) => {
    const [fg0, fg1] = await Promise.all([
      client.readContract({
        address: pool,
        abi: clPoolAbi,
        functionName: "feeGrowthGlobal0X128",
        blockNumber,
      }),
      client.readContract({
        address: pool,
        abi: clPoolAbi,
        functionName: "feeGrowthGlobal1X128",
        blockNumber,
      }),
    ]);
    return { fg0: fg0 as bigint, fg1: fg1 as bigint };
  };

  let now: { fg0: bigint; fg1: bigint };
  try {
    now = await readBoth();
  } catch {
    return null; // transient RPC failure — fee arm unquantifiable this run
  }

  const ladder: { hours: number; confidence: FeeRateEstimate["confidence"] }[] = [
    { hours: 24, confidence: "high" },
    { hours: 6, confidence: "medium" },
    { hours: 1, confidence: "low" },
  ];

  for (const { hours, confidence } of ladder) {
    const pastBlock = blockNow - BigInt(hours * BLOCKS_PER_HOUR);
    if (pastBlock <= 0n) continue;
    try {
      const past = await readBoth(pastBlock);
      const d0 = Number(now.fg0 - past.fg0) / 2 ** 128; // token0 raw per liq unit
      const d1 = Number(now.fg1 - past.fg1) / 2 ** 128;
      const usdPerLiq =
        d0 * (pricing.p0Usd / 10 ** pricing.dec0) +
        d1 * (pricing.p1Usd / 10 ** pricing.dec1);
      return {
        usdPerLiquidityPerDay: usdPerLiq / (hours / 24),
        windowHours: hours,
        confidence,
      };
    } catch {
      // RPC refused historical state at this depth — try a shorter window.
    }
  }
  return null; // no historical state at all: fee arm unquantifiable
}
