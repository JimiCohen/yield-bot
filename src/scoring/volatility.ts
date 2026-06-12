import type { ChainClient } from "../chain/client.js";
import { clPoolAbi } from "../chain/abis.js";
import type { Config } from "../config/schema.js";
import type { Store } from "../data/store.js";

/**
 * Realized volatility of the pool's relative price (which is exactly what
 * tick measures — including for cross pairs like WETH/cbBTC).
 *
 * Source ladder, best first:
 *  1. Pool's built-in oracle (observe): hourly TWAP segments over up to 24h.
 *     Many Aerodrome pools have tiny observation cardinality — handle OLD
 *     reverts by shrinking the window.
 *  2. Historical slot0 ticks at past blocks (needs archive-ish RPC).
 *  3. Our own accumulated price_samples (gets better as the bot runs).
 *  4. Config fallback vol — LOW confidence, flagged in output.
 *
 * Every score run also persists the current tick into price_samples, so
 * source 3 strengthens over time regardless of RPC capabilities.
 */

const LN_TICK = Math.log(1.0001);
const BLOCKS_PER_HOUR = 1800;
const YEAR_SECONDS = 31_536_000;

/** Run thunks with bounded concurrency — historical reads at distinct
 *  blocks can't be multicall-batched, and a 25-call burst trips public
 *  RPC rate limits. */
async function boundedAll<T>(thunks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(thunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, thunks.length) }, async () => {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]!();
    }
  });
  await Promise.all(workers);
  return results;
}

export interface VolEstimate {
  annual: number;
  source: "oracle" | "historical_slot0" | "local_samples" | "fallback";
  confidence: "high" | "medium" | "low";
  samples: number;
}

/** EWMA-annualized vol from a series of (elapsedSeconds, logReturn) pairs. */
function ewmaAnnualVol(
  intervals: { dtSec: number; logRet: number }[],
  lambda: number,
): number | null {
  if (intervals.length < 4) return null;
  // Normalize each return to per-second variance, EWMA over the sequence
  // (oldest first, so the most recent interval carries the most weight).
  let v: number | null = null;
  for (const { dtSec, logRet } of intervals) {
    if (dtSec <= 0) continue;
    const varPerSec = (logRet * logRet) / dtSec;
    v = v === null ? varPerSec : lambda * v + (1 - lambda) * varPerSec;
  }
  return v === null ? null : Math.sqrt(v * YEAR_SECONDS);
}

async function tryOracle(
  client: ChainClient,
  pool: `0x${string}`,
  lambda: number,
): Promise<VolEstimate | null> {
  // Try ladders of (window, step). Single observe call per attempt.
  const attempts: { windowH: number; stepMin: number; conf: VolEstimate["confidence"] }[] = [
    { windowH: 24, stepMin: 60, conf: "high" },
    { windowH: 6, stepMin: 30, conf: "medium" },
    { windowH: 1, stepMin: 10, conf: "low" },
  ];
  for (const { windowH, stepMin, conf } of attempts) {
    const stepSec = stepMin * 60;
    const n = Math.floor((windowH * 3600) / stepSec);
    const secondsAgos = Array.from({ length: n + 1 }, (_, i) => (n - i) * stepSec);
    try {
      const [tickCums] = (await client.readContract({
        address: pool,
        abi: clPoolAbi,
        functionName: "observe",
        args: [secondsAgos],
      })) as [bigint[], bigint[]];
      // TWAP tick per segment from cumulative-tick increments, then
      // log-returns between consecutive segment TWAPs.
      const twapTicks: number[] = [];
      for (let i = 1; i < tickCums.length; i++) {
        twapTicks.push(Number(tickCums[i]! - tickCums[i - 1]!) / stepSec);
      }
      const rets: { dtSec: number; logRet: number }[] = [];
      for (let i = 1; i < twapTicks.length; i++) {
        rets.push({ dtSec: stepSec, logRet: (twapTicks[i]! - twapTicks[i - 1]!) * LN_TICK });
      }
      const annual = ewmaAnnualVol(rets, lambda);
      if (annual !== null && annual > 0) {
        // Diffs of consecutive window-TWAPs damp realized variance by 2/3
        // (variance of differenced moving averages of BM), understating vol
        // and therefore LVR — correct by sqrt(3/2).
        const corrected = annual * Math.sqrt(1.5);
        return { annual: corrected, source: "oracle", confidence: conf, samples: rets.length };
      }
    } catch {
      // OLD revert or RPC failure — shrink the window.
    }
  }
  return null;
}

async function tryHistoricalSlot0(
  client: ChainClient,
  pool: `0x${string}`,
  blockNow: bigint,
  lambda: number,
): Promise<VolEstimate | null> {
  const attempts: { windowH: number; stepH: number; conf: VolEstimate["confidence"] }[] = [
    { windowH: 72, stepH: 3, conf: "high" },
    { windowH: 24, stepH: 1, conf: "medium" },
  ];
  for (const { windowH, stepH, conf } of attempts) {
    const n = Math.floor(windowH / stepH);
    try {
      const reads = await boundedAll(
        Array.from({ length: n + 1 }, (_, i) => () => {
          const blockNumber = blockNow - BigInt((n - i) * stepH * BLOCKS_PER_HOUR);
          return client.readContract({
            address: pool,
            abi: clPoolAbi,
            functionName: "slot0",
            blockNumber,
          });
        }),
        4,
      );
      const ticks = reads.map((r) => (r as readonly [bigint, number, ...unknown[]])[1]);
      const rets: { dtSec: number; logRet: number }[] = [];
      for (let i = 1; i < ticks.length; i++) {
        rets.push({ dtSec: stepH * 3600, logRet: (ticks[i]! - ticks[i - 1]!) * LN_TICK });
      }
      const annual = ewmaAnnualVol(rets, lambda);
      if (annual !== null && annual > 0) {
        return { annual, source: "historical_slot0", confidence: conf, samples: rets.length };
      }
    } catch {
      // non-archive RPC — try shallower, then give up.
    }
  }
  return null;
}

function tryLocalSamples(store: Store, pool: string, lambda: number): VolEstimate | null {
  const samples = store.getPriceSamples(pool, 14 * 24 * 3600);
  if (samples.length < 8) return null;
  const rets: { dtSec: number; logRet: number }[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dtSec = (samples[i]!.ts - samples[i - 1]!.ts) / 1000;
    if (dtSec < 60) continue; // ignore back-to-back scans
    rets.push({ dtSec, logRet: (samples[i]!.tick - samples[i - 1]!.tick) * LN_TICK });
  }
  const annual = ewmaAnnualVol(rets, lambda);
  if (annual === null || annual <= 0) return null;
  return {
    annual,
    source: "local_samples",
    confidence: rets.length > 50 ? "medium" : "low",
    samples: rets.length,
  };
}

export async function estimateVolatility(
  client: ChainClient,
  store: Store,
  cfg: Config,
  pool: `0x${string}`,
  pair: string,
  tickNow: number,
  blockNow: bigint,
): Promise<VolEstimate> {
  // Always feed the local sample store, whatever source we end up using.
  store.insertPriceSample(pool, Date.now(), Number(blockNow), tickNow);

  const lambda = cfg.volatility.ewma_lambda;
  const est =
    (await tryOracle(client, pool, lambda)) ??
    (await tryHistoricalSlot0(client, pool, blockNow, lambda)) ??
    tryLocalSamples(store, pool, lambda);
  if (est) return est;

  const fallback =
    cfg.volatility.fallback_annual[pair] ?? cfg.volatility.fallback_default;
  return { annual: fallback, source: "fallback", confidence: "low", samples: 0 };
}
