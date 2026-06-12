import { loadConfig } from "../config/load.js";
import { makeClient } from "../chain/client.js";
import { Store } from "../data/store.js";
import { scanPools } from "../data/scanner.js";
import { discoverAeroPricing } from "../scoring/emissions.js";
import { fetchHistory, type History, type TrackedPool } from "./history.js";
import { runBacktest } from "./backtest.js";

/**
 * Blue-chip thin-gauge pool research:
 *  1. 30-day on-chain history per pool: TVL, in-range staked depth (the
 *     "competition at the prize window"), gauge $/day, and DENSITY =
 *     prize $/day per $1k of in-range competition — the number that decides
 *     whether the tight play pays, and the curve that shows how fast each
 *     pocket gets crowded out (the rotation clock).
 *  2. Capital grid per pool (naive 5-min recenter policy, 3d fine replay):
 *     optimal amount per pool.
 */

const POOLS: Record<string, string> = {
  "0x4e392fbfe4d0557c82d2f97f02ec39daa31516dd": "WETH/USDC ts1",
  "0x9d14ff91ae2c6e3d1a760542248b6c7f206894b0": "USDC/cbBTC ts1",
  "0x7c7420dd105e2779316423ba3e973f434315efa9": "WETH/cbBTC ts1",
  "0x1131db5977242a03ebead1acd18f80a9a29e5922": "SOL/USDC ts10",
};
const AMOUNTS = [100, 400, 1000, 2500];
const AERO_USD = 0.354; // display-only for the density series

const cfg = loadConfig("config.yaml");
const client = makeClient(cfg);
const store = new Store(cfg.db.path);
const log = (m: string) => console.log(m);

const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
const aero = await discoverAeroPricing(client, cfg);
const gas = { gasPriceWei: await client.getGasPrice(), ethUsd: pricesUsd["WETH"]! };

// ---------- Part 1: 30-day series, 2h step --------------------------------
console.log("=== fetching 30d @ 2h history ===");
const histLong = await fetchHistory(cfg, client, store, snapshots, aero, { days: 30, stepHours: 2 }, log);

function tickToSqrt(t: number) { return Math.pow(1.0001, t / 2); }

for (const [pool, label] of Object.entries(POOLS)) {
  const tp = histLong.tracked.find((t) => t.pool.toLowerCase() === pool);
  if (!tp) { console.log(`\n${label}: NOT TRACKED (scan missed it)`); continue; }
  const samples = histLong.samples.get(pool)!;
  console.log(`\n=== ${label} (${pool.slice(0, 10)}…) — weekly snapshots over 30d ===`);
  console.log("WHEN        TVL        IN-RANGE DEPTH   PRIZE $/day   DENSITY $/day per $1k depth");
  const weekly = histLong.blocks.filter((_, i) => i % 84 === 0); // every 7d at 2h step
  for (const b of weekly) {
    const s = samples.get(b);
    if (!s) { continue; }
    const sNow = tickToSqrt(s.tick);
    // In-range staked depth in USD: virtual reserves of staked L at the
    // current tick — the competition a single-tick position shares the
    // prize with. v1 = L*s and v0-valued-in-t1 = L*s are equal at tick.
    const stakedL = Number(s.stakedLiquidity);
    const t1UsdPerRaw =
      tp.symbol1 === "USDC" ? 1e-6 :
      tp.symbol1 === "cbBTC" ? (pricesUsd["cbBTC"] ?? 0) / 1e8 :
      tp.symbol1 === "WETH" ? (pricesUsd["WETH"] ?? 0) / 1e18 :
      tp.symbol1 === "SOL" ? (pricesUsd["SOL"] ?? 0) / 1e9 : NaN;
    const depthUsd = stakedL * sNow * t1UsdPerRaw * 2; // both sides
    const prizeUsdDay = (Number(s.rewardRate) / 1e18) * 86400 * AERO_USD;
    const bal0Usd = Number(s.bal0) / 10 ** tp.dec0 * (pricesUsd[tp.symbol0] ?? 0);
    const bal1Usd = Number(s.bal1) / 10 ** tp.dec1 * (pricesUsd[tp.symbol1] ?? 0);
    const emitting = s.periodFinish > s.ts / 1000;
    console.log(
      `${new Date(s.ts).toISOString().slice(5, 10)}       ` +
      `$${Math.round(bal0Usd + bal1Usd).toLocaleString().padEnd(9)} ` +
      `$${Math.round(depthUsd).toLocaleString().padEnd(15)} ` +
      `$${Math.round(prizeUsdDay).toLocaleString().padEnd(12)} ` +
      `${depthUsd > 0 ? "$" + ((prizeUsdDay / depthUsd) * 1000).toFixed(1) : "-"}${emitting ? "" : " (gauge idle)"}`,
    );
  }
}

// ---------- Part 2: capital grid per pool, 3d @ 5min ----------------------
console.log("\n=== fetching 3d @ 5min history for capital grids ===");
const histFine = await fetchHistory(cfg, client, store, snapshots, aero, { days: 3, stepHours: 5 / 60 }, log);

console.log(`\nPOOL             AMOUNT   EMISSIONS  COSTS    REBAL  NET(3d)    ~APR`);
for (const [pool, label] of Object.entries(POOLS)) {
  const tp = histFine.tracked.find((t) => t.pool.toLowerCase() === pool);
  if (!tp) continue;
  const minWidth = Math.pow(1.0001, tp.tickSpacing / 2) * 1.00005; // ~single spacing
  for (const amount of AMOUNTS) {
    const cfgV = structuredClone(cfg);
    cfgV.capital_usdc = amount;
    cfgV.position.min_position_usd = amount;
    cfgV.position.max_pool_fraction = 1.0;
    cfgV.rebalance.sustain_minutes = 0;
    cfgV.rebalance.max_rebalances_per_day = 999;
    cfgV.rebalance.min_hold_minutes = 0;
    const res = runBacktest(cfgV, store, histFine, gas, () => {}, {
      forceEntry: true,
      forcePool: pool,
      forceWidthMult: minWidth,
      forceRebalance: true,
    });
    const e = res.entries;
    const sum = (f: (x: (typeof e)[0]) => number) => e.reduce((a, x) => a + f(x), 0);
    const net = res.finalEquityUsd - res.startCapitalUsd;
    console.log(
      `${label.padEnd(16)} ${("$" + amount).padEnd(8)} ` +
      `${("$" + (sum((x) => x.emissionsUsd) + sum((x) => x.feesUsd)).toFixed(2)).padEnd(10)} ` +
      `${("$" + sum((x) => x.costsUsd).toFixed(2)).padEnd(8)} ${String(sum((x) => x.rebalances)).padEnd(6)} ` +
      `${((net < 0 ? "-$" : "+$") + Math.abs(net).toFixed(2)).padEnd(10)} ` +
      `${((net / amount) * (365 / Math.max(0.5, res.daysSimulated)) * 100).toFixed(0)}%`,
    );
  }
}
store.close();
