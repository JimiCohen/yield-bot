import { zeroAddress } from "viem";
import type { ChainClient } from "../chain/client.js";
import type { Config } from "../config/schema.js";
import { AERODROME } from "../chain/addresses.js";
import { clFactoryAbi, clGaugeAbi, clPoolAbi, erc20Abi, voterAbi } from "../chain/abis.js";
import type { PoolSnapshot } from "../types.js";
import { advisoryApy, type LlamaAdvisory } from "./llama.js";

/**
 * Phase 1 scanner.
 *
 * Discovery is DETERMINISTIC, not heuristic: the allowlist defines every
 * pair we are allowed to touch, and Slipstream pools are keyed by
 * (tokenA, tokenB, tickSpacing), so we probe the factory for each pair x
 * spacing directly. No reliance on third-party pool lists for anything
 * execution-relevant. DeFiLlama supplies an advisory APY column only.
 *
 * Hard filters (all must pass):
 *   - both tokens on the asset allowlist (guaranteed by construction)
 *   - on-chain TVL > min_tvl_usdc, valued via on-chain prices
 *   - gauge exists and Voter.isAlive(gauge) — a killed/missing gauge is the
 *     on-chain marker for deprecated or migrating pools
 */

interface Probe {
  symA: string;
  symB: string;
  tickSpacing: number;
}

export interface ScanResult {
  blockNumber: bigint;
  snapshots: PoolSnapshot[];
  /** USDC prices used for TVL valuation, for the audit trail. */
  pricesUsd: Record<string, number>;
}

/** sqrtPriceX96 -> human price of token0 in token1 units (decimal-adjusted).
 *  Double-precision is fine for valuation/scanning; execution math (later
 *  phases) stays in bigint tick space. */
function priceToken0InToken1(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 10 ** (dec0 - dec1);
}

/** Result shape of an allowFailure multicall entry, untyped on purpose:
 *  heterogeneous batched calls defeat viem's tuple inference. */
type McResult = { status: "success" | "failure"; result?: unknown; error?: Error };

export async function scanPools(
  cfg: Config,
  client: ChainClient,
  llama: LlamaAdvisory | null,
): Promise<ScanResult> {
  const tokens = cfg.allowlist.tokens;
  const addrToSym = new Map<string, string>(
    Object.entries(tokens).map(([sym, t]) => [t.address.toLowerCase(), sym]),
  );

  // ---- 1. Probe BOTH factories for every allowlisted pair x tick spacing --
  // Aerodrome runs two Slipstream factories; the same (pair, spacing) can
  // exist in each as different pools. Dedup by pool address.
  const factories = [AERODROME.clFactory, AERODROME.clFactory2] as const;
  const probes: Probe[] = [];
  for (const [a, b] of cfg.allowlist.pairs) {
    for (const ts of cfg.scanner.tick_spacings) {
      probes.push({ symA: a, symB: b, tickSpacing: ts });
    }
  }

  const blockNumber = await client.getBlockNumber();

  const poolAddrResults = (await client.multicall({
    contracts: factories.flatMap((factory) =>
      probes.map((p) => ({
        address: factory as `0x${string}`,
        abi: clFactoryAbi,
        functionName: "getPool" as const,
        args: [
          tokens[p.symA]!.address as `0x${string}`,
          tokens[p.symB]!.address as `0x${string}`,
          p.tickSpacing,
        ],
      })),
    ),
    allowFailure: true,
  })) as { status: string; result?: unknown }[];

  const seen = new Set<string>();
  const found: { probe: Probe; pool: `0x${string}`; factory: `0x${string}` }[] = [];
  factories.forEach((factory, fi) => {
    probes.forEach((probe, i) => {
      const r = poolAddrResults[fi * probes.length + i];
      if (r?.status === "success" && r.result !== zeroAddress) {
        const pool = (r.result as string).toLowerCase();
        if (!seen.has(pool)) {
          seen.add(pool);
          found.push({ probe, pool: r.result as `0x${string}`, factory: factory as `0x${string}` });
        }
      }
    });
  });

  if (found.length === 0) {
    // For WETH/USDC on Aerodrome this cannot legitimately happen — treat as
    // a misconfiguration (wrong factory address / wrong chain), not as data.
    throw new Error(
      "Factory probe found zero pools for allowlisted pairs — check factory address and RPC chain.",
    );
  }

  // ---- 2. Pool state + gauge lookup in one multicall ---------------------
  const stateCalls = found.flatMap(({ pool }) => [
    { address: pool, abi: clPoolAbi, functionName: "slot0" as const },
    { address: pool, abi: clPoolAbi, functionName: "liquidity" as const },
    { address: pool, abi: clPoolAbi, functionName: "stakedLiquidity" as const },
    { address: pool, abi: clPoolAbi, functionName: "fee" as const },
    { address: pool, abi: clPoolAbi, functionName: "token0" as const },
    { address: pool, abi: clPoolAbi, functionName: "token1" as const },
    {
      address: AERODROME.voter as `0x${string}`,
      abi: voterAbi,
      functionName: "gauges" as const,
      args: [pool] as const,
    },
  ]);
  const PER_POOL = 7;
  const stateResults = (await client.multicall({
    contracts: stateCalls as never,
    allowFailure: true,
  })) as McResult[];

  interface RawPool {
    probe: Probe;
    pool: `0x${string}`;
    factory: `0x${string}`;
    sqrtPriceX96: bigint;
    tick: number;
    liquidity: bigint;
    stakedLiquidity: bigint | null;
    feePips: number | null;
    token0: `0x${string}`;
    token1: `0x${string}`;
    gauge: `0x${string}` | null;
  }

  const raws: RawPool[] = [];
  found.forEach(({ probe, pool, factory }, i) => {
    const base = i * PER_POOL;
    const slot0 = stateResults[base];
    const liq = stateResults[base + 1];
    const staked = stateResults[base + 2];
    const fee = stateResults[base + 3];
    const t0 = stateResults[base + 4];
    const t1 = stateResults[base + 5];
    const gauge = stateResults[base + 6];
    if (slot0?.status !== "success" || liq?.status !== "success" ||
        t0?.status !== "success" || t1?.status !== "success") {
      console.warn(`  ! skipping ${pool} (${probe.symA}/${probe.symB} ts=${probe.tickSpacing}): core state read failed`);
      return;
    }
    const s = slot0.result as readonly [bigint, number, number, number, number, boolean];
    const gaugeAddr =
      gauge?.status === "success" && gauge.result !== zeroAddress
        ? (gauge.result as `0x${string}`)
        : null;
    raws.push({
      probe,
      pool,
      factory,
      sqrtPriceX96: s[0],
      tick: s[1],
      liquidity: liq.result as bigint,
      stakedLiquidity: staked?.status === "success" ? (staked.result as bigint) : null,
      feePips: fee?.status === "success" ? Number(fee.result) : null,
      token0: t0.result as `0x${string}`,
      token1: t1.result as `0x${string}`,
      gauge: gaugeAddr,
    });
  });

  // ---- 3. Balances + gauge detail in a second multicall ------------------
  const detailCalls = raws.flatMap((r) => [
    {
      address: r.token0,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [r.pool] as const,
    },
    {
      address: r.token1,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [r.pool] as const,
    },
    {
      address: AERODROME.voter as `0x${string}`,
      abi: voterAbi,
      functionName: "isAlive" as const,
      args: [r.gauge ?? zeroAddress] as const,
    },
    {
      address: r.gauge ?? zeroAddress,
      abi: clGaugeAbi,
      functionName: "rewardRate" as const,
    },
    {
      address: r.gauge ?? zeroAddress,
      abi: clGaugeAbi,
      functionName: "periodFinish" as const,
    },
  ]);
  const PER_DETAIL = 5;
  const detailResults = (await client.multicall({
    contracts: detailCalls as never,
    allowFailure: true,
  })) as McResult[];

  // ---- 4. Derive USDC reference prices from the pools themselves ---------
  // For each non-USDC token, use its deepest token/USDC pool (by USDC
  // balance) as the price reference. Scanning-grade pricing; execution
  // phases will use TWAP + manipulation checks.
  const usdcAddr = tokens["USDC"]!.address.toLowerCase();
  const pricesUsd: Record<string, number> = { USDC: 1 };
  for (const sym of Object.keys(tokens)) {
    if (sym === "USDC") continue;
    let bestUsdcBal = -1n;
    let bestPrice: number | null = null;
    raws.forEach((r, i) => {
      const s0 = addrToSym.get(r.token0.toLowerCase());
      const s1 = addrToSym.get(r.token1.toLowerCase());
      const isPair =
        (s0 === sym && r.token1.toLowerCase() === usdcAddr) ||
        (s1 === sym && r.token0.toLowerCase() === usdcAddr);
      if (!isPair) return;
      const balRes = detailResults[i * PER_DETAIL + (r.token0.toLowerCase() === usdcAddr ? 0 : 1)];
      const usdcBal = balRes?.status === "success" ? (balRes.result as bigint) : 0n;
      if (usdcBal <= bestUsdcBal) return;
      const dec0 = tokens[s0!]!.decimals;
      const dec1 = tokens[s1!]!.decimals;
      const p01 = priceToken0InToken1(r.sqrtPriceX96, dec0, dec1);
      bestUsdcBal = usdcBal;
      bestPrice = s0 === sym ? p01 : 1 / p01; // price of `sym` in USDC
    });
    if (bestPrice !== null) pricesUsd[sym] = bestPrice;
  }

  // ---- 5. Assemble snapshots and apply hard filters -----------------------
  const snapshots: PoolSnapshot[] = raws.map((r, i) => {
    const base = i * PER_DETAIL;
    const bal0Res = detailResults[base];
    const bal1Res = detailResults[base + 1];
    const aliveRes = detailResults[base + 2];
    const rateRes = detailResults[base + 3];
    const finishRes = detailResults[base + 4];

    const symbol0 = addrToSym.get(r.token0.toLowerCase()) ?? "?";
    const symbol1 = addrToSym.get(r.token1.toLowerCase()) ?? "?";
    const bal0 = bal0Res?.status === "success" ? (bal0Res.result as bigint) : 0n;
    const bal1 = bal1Res?.status === "success" ? (bal1Res.result as bigint) : 0n;

    const p0 = pricesUsd[symbol0];
    const p1 = pricesUsd[symbol1];
    const dec0 = tokens[symbol0]?.decimals ?? 18;
    const dec1 = tokens[symbol1]?.decimals ?? 18;
    const tvlUsdc =
      p0 !== undefined && p1 !== undefined
        ? (Number(bal0) / 10 ** dec0) * p0 + (Number(bal1) / 10 ** dec1) * p1
        : 0;

    const gaugeAlive =
      r.gauge === null
        ? null
        : aliveRes?.status === "success"
          ? (aliveRes.result as boolean)
          : null;

    const failReasons: string[] = [];
    if (tvlUsdc <= cfg.filters.min_tvl_usdc) {
      failReasons.push(
        `TVL_BELOW_MIN (${Math.round(tvlUsdc).toLocaleString()} <= ${cfg.filters.min_tvl_usdc.toLocaleString()})`,
      );
    }
    if (cfg.filters.require_alive_gauge) {
      if (r.gauge === null) failReasons.push("NO_GAUGE");
      else if (gaugeAlive !== true) failReasons.push("GAUGE_KILLED_OR_UNKNOWN");
    }

    return {
      pool: r.pool,
      factory: r.factory,
      pair: `${symbol0}/${symbol1}`,
      symbol0,
      symbol1,
      token0: r.token0,
      token1: r.token1,
      tickSpacing: r.probe.tickSpacing,
      feePips: r.feePips,
      sqrtPriceX96: r.sqrtPriceX96,
      tick: r.tick,
      liquidity: r.liquidity,
      stakedLiquidity: r.stakedLiquidity,
      bal0,
      bal1,
      tvlUsdc,
      gauge: r.gauge,
      gaugeAlive,
      rewardRate:
        r.gauge !== null && rateRes?.status === "success" ? (rateRes.result as bigint) : null,
      periodFinish:
        r.gauge !== null && finishRes?.status === "success"
          ? Number(finishRes.result as bigint)
          : null,
      llamaApy: advisoryApy(llama, r.token0, r.token1),
      eligible: failReasons.length === 0,
      failReasons,
    };
  });

  return { blockNumber, snapshots, pricesUsd };
}
