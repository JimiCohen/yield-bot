import { zeroAddress } from "viem";
import type { ChainClient } from "../chain/client.js";
import { clGaugeAbi, clPoolAbi, erc20Abi } from "../chain/abis.js";
import type { Config } from "../config/schema.js";
import type { Store } from "../data/store.js";
import type { PoolSnapshot } from "../types.js";
import type { AeroPricing } from "../scoring/emissions.js";

/**
 * Historical on-chain state sampler.
 *
 * For every tracked pool we fetch (slot0, liquidity, stakedLiquidity,
 * feeGrowthGlobal0/1, balances, gauge rewardRate) at evenly spaced past
 * blocks — ONE multicall per block covers all pools, so a 14-day / 2-hour
 * backtest costs ~170 RPC calls regardless of pool count. Samples are
 * cached in SQLite, so reruns and longer windows are incremental.
 *
 * Survivorship handling: we track every pool the factory probe found —
 * including pools that today fail TVL/gauge filters (e.g. the deprecated
 * tick-spacing-1 pools with killed gauges). The replay engine applies the
 * filters with AS-OF data, so pools that died during the window are
 * candidates while they were alive, exactly as they would have been.
 *
 * Known approximations (documented, all conservative or negligible):
 *  - Sample timestamps derived from Base's 2s block time, not per-block
 *    header fetches.
 *  - Gauge addresses as of today; a gauge replaced mid-window would read
 *    zero rewardRate (treated as no emissions — conservative).
 *  - Gas priced at the current gas price for the whole window (Base gas is
 *    consistently sub-cent in USD; variance is noise at our cost scale).
 */

export interface HistSample {
  ts: number; // ms epoch, estimated from block delta
  block: number;
  tick: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  stakedLiquidity: bigint;
  fg0: bigint;
  fg1: bigint;
  rewardRate: bigint;
  /**
   * Gauge periodFinish (unix seconds). CRITICAL: a killed gauge keeps
   * returning its last nonzero rewardRate forever, but receives no new
   * epochs — emissions are flowing ONLY while ts < periodFinish. Ignoring
   * this made dead pools look like emission goldmines in early testing.
   */
  periodFinish: number;
  bal0: bigint;
  bal1: bigint;
}

export interface TrackedPool {
  pool: `0x${string}`;
  pair: string;
  symbol0: string;
  symbol1: string;
  dec0: number;
  dec1: number;
  tickSpacing: number;
  feePips: number;
  gauge: `0x${string}` | null;
  token0: `0x${string}`;
  token1: `0x${string}`;
}

export interface History {
  blocks: number[];
  tsForBlock: (block: number) => number;
  /** poolAddressLower -> block -> sample (missing = unreadable at block) */
  samples: Map<string, Map<number, HistSample>>;
  tracked: TrackedPool[];
  aeroTracked: TrackedPool | null;
}

const BLOCK_SECONDS = 2;
const CALLS_PER_POOL = 7; // slot0, liquidity, staked, fg0, fg1, bal0, bal1

export async function fetchHistory(
  cfg: Config,
  client: ChainClient,
  store: Store,
  snapshots: PoolSnapshot[],
  aero: AeroPricing | null,
  opts: { days: number; stepHours: number },
  log: (msg: string) => void,
): Promise<History> {
  const blockNowRaw = Number(await client.getBlockNumber());
  const stepBlocks = Math.round((opts.stepHours * 3600) / BLOCK_SECONDS);
  // Grid-align the anchor so consecutive runs share sample blocks and the
  // cache actually hits (an unaligned anchor refetched everything each run).
  const blockNow = Math.floor(blockNowRaw / stepBlocks) * stepBlocks;
  const nowMs = Date.now() - (blockNowRaw - blockNow) * BLOCK_SECONDS * 1000;
  const nSteps = Math.floor((opts.days * 24) / opts.stepHours);
  const blocks: number[] = [];
  for (let i = nSteps; i >= 0; i--) blocks.push(blockNow - i * stepBlocks);

  // Track every discovered pool above a dust floor — including currently
  // dead/rejected ones (no survivorship bias).
  const tracked: TrackedPool[] = snapshots
    .filter((s) => s.tvlUsdc >= 1000)
    .map((s) => ({
      pool: s.pool,
      pair: s.pair,
      symbol0: s.symbol0,
      symbol1: s.symbol1,
      dec0: cfg.allowlist.tokens[s.symbol0]!.decimals,
      dec1: cfg.allowlist.tokens[s.symbol1]!.decimals,
      tickSpacing: s.tickSpacing,
      feePips: s.feePips ?? 0,
      gauge: s.gauge,
      token0: s.token0,
      token1: s.token1,
    }));

  // The AERO/USDC pool rides along for realized emission valuation.
  let aeroTracked: TrackedPool | null = null;
  if (aero) {
    aeroTracked = {
      pool: aero.pool,
      pair: "AERO/USDC",
      symbol0: aero.pricing.dec0 === 18 ? "AERO" : "USDC",
      symbol1: aero.pricing.dec0 === 18 ? "USDC" : "AERO",
      dec0: aero.pricing.dec0,
      dec1: aero.pricing.dec1,
      tickSpacing: 0,
      feePips: Math.round(aero.poolFeeFraction * 1e6),
      gauge: null,
      token0: zeroAddress, // balances not needed for the pricing pool
      token1: zeroAddress,
    };
  }
  const all = aeroTracked ? [...tracked, aeroTracked] : tracked;

  const samples = new Map<string, Map<number, HistSample>>();
  for (const t of all) samples.set(t.pool.toLowerCase(), new Map());

  // Load cache; figure out which blocks still need fetching.
  const cachedBlocks = new Set<number>();
  {
    const rows = store.getHistoryBlocks(all.map((t) => t.pool.toLowerCase()));
    // a block counts as cached only if every tracked pool has a row (or a
    // recorded miss) for it
    const byBlock = new Map<number, number>();
    for (const r of rows) byBlock.set(r.block, (byBlock.get(r.block) ?? 0) + 1);
    for (const [b, n] of byBlock) if (n >= all.length) cachedBlocks.add(b);
  }
  const toFetch = blocks.filter((b) => !cachedBlocks.has(b));
  log(
    `History: ${blocks.length} sample blocks over ${opts.days}d (step ${opts.stepHours}h); ` +
      `${blocks.length - toFetch.length} cached, ${toFetch.length} to fetch for ${all.length} pools.`,
  );

  let fetched = 0;
  for (const block of toFetch) {
    const contracts = all.flatMap((t) => [
      { address: t.pool, abi: clPoolAbi, functionName: "slot0" as const },
      { address: t.pool, abi: clPoolAbi, functionName: "liquidity" as const },
      { address: t.pool, abi: clPoolAbi, functionName: "stakedLiquidity" as const },
      { address: t.pool, abi: clPoolAbi, functionName: "feeGrowthGlobal0X128" as const },
      { address: t.pool, abi: clPoolAbi, functionName: "feeGrowthGlobal1X128" as const },
      t.token0 === zeroAddress
        ? { address: t.pool, abi: clPoolAbi, functionName: "liquidity" as const }
        : { address: t.token0, abi: erc20Abi, functionName: "balanceOf" as const, args: [t.pool] as const },
      t.token1 === zeroAddress
        ? { address: t.pool, abi: clPoolAbi, functionName: "liquidity" as const }
        : { address: t.token1, abi: erc20Abi, functionName: "balanceOf" as const, args: [t.pool] as const },
    ]);
    const gaugeOffset = contracts.length;
    const gauged = all.filter((t) => t.gauge !== null);
    for (const t of gauged) {
      contracts.push(
        {
          address: t.gauge!,
          abi: clGaugeAbi,
          functionName: "rewardRate" as const,
        } as never,
        {
          address: t.gauge!,
          abi: clGaugeAbi,
          functionName: "periodFinish" as const,
        } as never,
      );
    }

    let results: { status: string; result?: unknown }[];
    try {
      results = (await client.multicall({
        contracts: contracts as never,
        allowFailure: true,
        blockNumber: BigInt(block),
      })) as { status: string; result?: unknown }[];
    } catch {
      // RPC refused this depth entirely — record misses so we don't retry,
      // engine will see no data before this point.
      for (const t of all) store.insertHistorySample(t.pool.toLowerCase(), block, null);
      continue;
    }

    all.forEach((t, i) => {
      const base = i * CALLS_PER_POOL;
      const slot0 = results[base];
      if (slot0?.status !== "success") {
        store.insertHistorySample(t.pool.toLowerCase(), block, null);
        return;
      }
      const s0 = slot0.result as readonly [bigint, number, ...unknown[]];
      const get = (off: number): bigint => {
        const r = results[base + off];
        return r?.status === "success" ? (r.result as bigint) : 0n;
      };
      const gi = gauged.indexOf(t);
      const rewardRate =
        gi >= 0 && results[gaugeOffset + gi * 2]?.status === "success"
          ? (results[gaugeOffset + gi * 2]!.result as bigint)
          : 0n;
      const periodFinish =
        gi >= 0 && results[gaugeOffset + gi * 2 + 1]?.status === "success"
          ? Number(results[gaugeOffset + gi * 2 + 1]!.result as bigint)
          : 0;
      const sample: HistSample = {
        ts: nowMs - (blockNow - block) * BLOCK_SECONDS * 1000,
        block,
        tick: s0[1],
        sqrtPriceX96: s0[0],
        liquidity: get(1),
        stakedLiquidity: get(2),
        fg0: get(3),
        fg1: get(4),
        bal0: get(5),
        bal1: get(6),
        rewardRate,
        periodFinish,
      };
      store.insertHistorySample(t.pool.toLowerCase(), block, sample);
    });
    fetched++;
    if (fetched % 20 === 0) log(`  fetched ${fetched}/${toFetch.length} blocks...`);
  }

  // Load everything (cache + fresh) into memory.
  for (const t of all) {
    const rows = store.getHistorySamples(t.pool.toLowerCase());
    const m = samples.get(t.pool.toLowerCase())!;
    for (const r of rows) {
      if (blocks.includes(r.block) && r.sample) m.set(r.block, r.sample);
    }
  }

  return {
    blocks,
    tsForBlock: (b) => nowMs - (blockNow - b) * BLOCK_SECONDS * 1000,
    samples,
    tracked,
    aeroTracked,
  };
}
