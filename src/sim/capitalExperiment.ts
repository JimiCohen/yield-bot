import { loadConfig } from "../config/load.js";
import { makeClient } from "../chain/client.js";
import { Store } from "../data/store.js";
import { scanPools } from "../data/scanner.js";
import { discoverAeroPricing } from "../scoring/emissions.js";
import { fetchHistory } from "./history.js";
import { runBacktest } from "./backtest.js";

/**
 * Capital x width grid on ONE pool (the user's high-emission USDC/cbBTC
 * tick-spacing-1 pool), naive policy: check every 5 minutes, recenter
 * whenever out of range — replayed over the real last 3 days.
 *
 * Why capital matters here: in-range staked depth on this pool is tiny
 * (single-tick staked liquidity ≈ $6.5k), so emissions captured saturate —
 * your share approaches 100% of the gauge's fixed $/day as capital grows,
 * while divergence (LVR) scales LINEARLY with capital forever. The grid
 * makes that crossover visible empirically.
 *
 * Honest granularity caveat: 5-minute checks are the management cadence
 * floor. Ultra-tight bands (±0.01%) exit within seconds at current vol;
 * between checks the sim credits little in-range accrual, mirroring what a
 * 5-minute manager would actually capture. A per-block (2s) manager
 * approaches the continuous limit, where the bleed rate IS the LVR —
 * faster management does not change the sign, only the smoothness.
 */

const POOL = "0x9d14ff91ae2c6e3d1a760542248b6c7f206894b0";
const WIDTHS = [
  { label: "±0.01%", m: 1.0001 },
  { label: "±0.03%", m: 1.0003 },
  { label: "±0.07%", m: 1.0007 },
  { label: "±0.5%", m: 1.005 },
];
const CAPITALS = [100, 400, 1000, 5000, 25000];
const DAYS = 3;
const STEP_HOURS = 5 / 60;

const cfg = loadConfig("config.yaml");
const client = makeClient(cfg);
const store = new Store(cfg.db.path);

console.log(`Capital x width grid on ${POOL} (naive recenter-always, 5-min checks, ${DAYS}d real data)`);
const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
const aero = await discoverAeroPricing(client, cfg);
const gas = { gasPriceWei: await client.getGasPrice(), ethUsd: pricesUsd["WETH"]! };
const hist = await fetchHistory(
  cfg, client, store, snapshots, aero, { days: DAYS, stepHours: STEP_HOURS },
  (m) => console.log(m),
);

interface Cell {
  width: string;
  capital: number;
  emis: number;
  dv: number;
  costs: number;
  rebal: number;
  net: number;
  aprPct: number;
}
const cells: Cell[] = [];

for (const w of WIDTHS) {
  for (const c of CAPITALS) {
    const cfgV = structuredClone(cfg);
    cfgV.capital_usdc = c;
    cfgV.position.min_position_usd = c;
    cfgV.position.max_pool_fraction = 1.0;
    cfgV.rebalance.sustain_minutes = 0;
    cfgV.rebalance.max_rebalances_per_day = 999;
    const res = runBacktest(cfgV, store, hist, gas, () => {}, {
      forceEntry: true,
      forcePool: POOL,
      forceWidthMult: w.m,
      forceRebalance: true,
    });
    const e = res.entries;
    const sum = (f: (x: (typeof e)[0]) => number) => e.reduce((a, x) => a + f(x), 0);
    const net = res.finalEquityUsd - res.startCapitalUsd;
    cells.push({
      width: w.label,
      capital: c,
      emis: sum((x) => x.emissionsUsd) + sum((x) => x.feesUsd),
      dv: sum((x) => x.valueChangeUsd),
      costs: sum((x) => x.costsUsd),
      rebal: sum((x) => x.rebalances),
      net,
      aprPct: (net / c) * (365 / res.daysSimulated) * 100,
    });
    console.log(`  done ${w.label} @ $${c}`);
  }
}

console.log(`\n${"WIDTH".padEnd(8)} ${"CAPITAL".padEnd(9)} ${"EMISSIONS".padEnd(10)} ${"ΔVALUE".padEnd(10)} ${"COSTS".padEnd(8)} ${"REBAL".padEnd(6)} ${"NET (3d)".padEnd(10)} ~APR`);
for (const x of cells) {
  console.log(
    `${x.width.padEnd(8)} ${("$" + x.capital.toLocaleString()).padEnd(9)} ` +
      `${("$" + x.emis.toFixed(2)).padEnd(10)} ${((x.dv < 0 ? "-$" : "+$") + Math.abs(x.dv).toFixed(2)).padEnd(10)} ` +
      `${("$" + x.costs.toFixed(2)).padEnd(8)} ${String(x.rebal).padEnd(6)} ` +
      `${((x.net < 0 ? "-$" : "+$") + Math.abs(x.net).toFixed(2)).padEnd(10)} ${x.aprPct.toFixed(0)}%`,
  );
}
store.close();
