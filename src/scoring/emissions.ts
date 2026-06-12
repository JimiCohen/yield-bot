import { zeroAddress } from "viem";
import type { ChainClient } from "../chain/client.js";
import { AERODROME } from "../chain/addresses.js";
import { clFactoryAbi, clPoolAbi, erc20Abi } from "../chain/abis.js";
import type { Config } from "../config/schema.js";
import {
  swapImpactFraction,
  sRaw,
  virtualReservesUsd,
  type PoolPricing,
} from "./clmath.js";

/**
 * Realizable AERO valuation: "if we harvested and sold this lot right now,
 * what USDC would we actually hold" — then haircut and decay.
 *
 * Realizable price is derived from the deepest AERO/USDC Slipstream pool's
 * own state (spot − pool fee − size-aware impact via virtual reserves), not
 * from any price API. If no AERO/USDC pool can be found on-chain, the
 * emission arm is valued at ZERO and flagged — refusing to value the
 * dominant yield source beats inventing a price for it.
 */

export interface AeroPricing {
  spotUsd: number;
  poolFeeFraction: number;
  pool: `0x${string}`;
  liquidity: bigint;
  pricing: PoolPricing;
}

export async function discoverAeroPricing(
  client: ChainClient,
  cfg: Config,
): Promise<AeroPricing | null> {
  const usdc = cfg.allowlist.tokens["USDC"]!;
  const probes = await client.multicall({
    contracts: [AERODROME.clFactory, AERODROME.clFactory2].flatMap((factory) =>
      cfg.scanner.tick_spacings.map((ts) => ({
        address: factory as `0x${string}`,
        abi: clFactoryAbi,
        functionName: "getPool" as const,
        args: [AERODROME.aero as `0x${string}`, usdc.address as `0x${string}`, ts],
      })),
    ),
    allowFailure: true,
  });

  let best: AeroPricing | null = null;
  for (const probe of probes) {
    if (probe.status !== "success" || probe.result === zeroAddress) continue;
    const pool = probe.result as `0x${string}`;
    try {
      const [slot0, liquidity, fee, token0] = await Promise.all([
        client.readContract({ address: pool, abi: clPoolAbi, functionName: "slot0" }),
        client.readContract({ address: pool, abi: clPoolAbi, functionName: "liquidity" }),
        client.readContract({ address: pool, abi: clPoolAbi, functionName: "fee" }),
        client.readContract({ address: pool, abi: clPoolAbi, functionName: "token0" }),
      ]);
      const s0 = slot0 as readonly [bigint, number, ...unknown[]];
      const aeroIs0 = (token0 as string).toLowerCase() === AERODROME.aero.toLowerCase();
      const sq = sRaw(s0[0]);
      const rawP01 = sq * sq; // token1 raw per token0 raw
      // AERO has 18 decimals, USDC 6.
      const spotUsd = aeroIs0
        ? rawP01 * 10 ** (18 - 6)
        : (1 / rawP01) * 10 ** (18 - 6);
      const candidate: AeroPricing = {
        spotUsd,
        poolFeeFraction: Number(fee) / 1e6,
        pool,
        liquidity: liquidity as bigint,
        pricing: {
          sqrtPriceX96: s0[0],
          dec0: aeroIs0 ? 18 : 6,
          dec1: aeroIs0 ? 6 : 18,
          p0Usd: aeroIs0 ? spotUsd : 1,
          p1Usd: aeroIs0 ? 1 : spotUsd,
        },
      };
      // Select by USD depth, NOT raw liquidity: raw L is per-tick density
      // and favors thin tight-spacing pools, which made harvest "impact"
      // look catastrophic and silently zeroed the emission arm everywhere.
      const depth = (c: AeroPricing) => {
        const v = virtualReservesUsd(c.liquidity, c.pricing);
        return Math.min(v.v0Usd, v.v1Usd);
      };
      if (!best || depth(candidate) > depth(best)) best = candidate;
    } catch {
      // unreadable candidate — skip
    }
  }
  return best;
}

/**
 * Net realizable USD value of an AERO amount accrued over the horizon:
 *   spot · (1 − pool fee) · (1 − DAILY-lot impact) · (1 − haircut) · decay(H)
 *
 * Impact is modeled on the DAILY harvest lot, not the whole horizon in one
 * swap — the bot compounds at least daily, and pricing a week's harvest as
 * a single market sell overstated impact enough to zero out the emission
 * arm on every pool. haircut covers realization timing + structural sell
 * pressure; decay is assumed price erosion. Re-fit both against realized.
 */
export function realizableAeroUsd(
  aeroAmount: number,
  aero: AeroPricing,
  cfg: Config,
): number {
  const grossUsd = aeroAmount * aero.spotUsd;
  const dailyLotUsd = grossUsd / Math.max(1, cfg.scoring.horizon_days);
  const impact = swapImpactFraction(aero.liquidity, aero.pricing, dailyLotUsd);
  const decay = Math.pow(
    1 - cfg.scoring.emission_decay_30d,
    cfg.scoring.horizon_days / 30,
  );
  return (
    grossUsd *
    (1 - aero.poolFeeFraction) *
    (1 - impact) *
    (1 - cfg.scoring.emission_haircut) *
    decay
  );
}
