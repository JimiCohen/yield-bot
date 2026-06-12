import { loadConfig } from "../config/load.js";
import { makeClient } from "../chain/client.js";
import { Store } from "../data/store.js";
import { scanPools } from "../data/scanner.js";
import { discoverAeroPricing } from "../scoring/emissions.js";
import { fetchHistory, type History } from "./history.js";
import { runBacktest } from "./backtest.js";

/**
 * CHECK-cadence experiment (the user's exact question): how often should
 * the bot LOOK — rebalancing only when the gates say it's needed (beyond
 * deadband + net-benefit), never on a timer.
 *
 * One 1-day history at 60-SECOND granularity; replays at check cadences of
 * 60s / 5m / 10m / 20m via subsampling, on the two pools that proved
 * profitable, at their measured optimal sizes, at tight width.
 */

const PLAYS = [
  { pool: "0x9d14ff91ae2c6e3d1a760542248b6c7f206894b0", label: "USDC/cbBTC", amount: 400, width: 1.0001 },
  { pool: "0x1131db5977242a03ebead1acd18f80a9a29e5922", label: "SOL/USDC", amount: 1000, width: 1.0005 },
];
const CADENCES = [
  { label: "60 sec", k: 1, minutes: 1 },
  { label: "5 min", k: 5, minutes: 5 },
  { label: "10 min", k: 10, minutes: 10 },
  { label: "20 min", k: 20, minutes: 20 },
];
const DAYS = 1;
const STEP_HOURS = 1 / 60;

function subsample(hist: History, k: number): History {
  return { ...hist, blocks: hist.blocks.filter((_, i) => i % k === 0) };
}

const cfg = loadConfig("config.yaml");
const client = makeClient(cfg);
const store = new Store(cfg.db.path);

console.log(`Check-cadence experiment: ${DAYS}d @ 60s granularity, gated rebalancing only`);
const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
const aero = await discoverAeroPricing(client, cfg);
const gas = { gasPriceWei: await client.getGasPrice(), ethUsd: pricesUsd["WETH"]! };
const hist = await fetchHistory(
  cfg, client, store, snapshots, aero, { days: DAYS, stepHours: STEP_HOURS },
  (m) => console.log(m),
);

console.log(`\n${"POOL".padEnd(12)} ${"CHECK".padEnd(8)} ${"AMOUNT".padEnd(8)} ${"EMISSIONS".padEnd(10)} ${"REBAL".padEnd(6)} ${"COSTS".padEnd(8)} NET(1d)`);
for (const play of PLAYS) {
  for (const c of CADENCES) {
    const cfgV = structuredClone(cfg);
    cfgV.capital_usdc = play.amount;
    cfgV.position.min_position_usd = play.amount;
    cfgV.position.max_pool_fraction = 1.0;
    cfgV.rebalance.check_interval_minutes = c.minutes;
    cfgV.rebalance.sustain_minutes = 0;
    cfgV.rebalance.min_hold_minutes = 0;
    cfgV.rebalance.max_rebalances_per_day = 1440; // gates decide, not the cap
    const res = runBacktest(cfgV, store, subsample(hist, c.k), gas, () => {}, {
      forceEntry: true,
      forcePool: play.pool,
      forceWidthMult: play.width,
      // NO forceRebalance: deadband + net-benefit gates decide
    });
    const e = res.entries;
    const sum = (f: (x: (typeof e)[0]) => number) => e.reduce((a, x) => a + f(x), 0);
    const net = res.finalEquityUsd - res.startCapitalUsd;
    console.log(
      `${play.label.padEnd(12)} ${c.label.padEnd(8)} ${("$" + play.amount).padEnd(8)} ` +
        `${("$" + (sum((x) => x.emissionsUsd) + sum((x) => x.feesUsd)).toFixed(2)).padEnd(10)} ` +
        `${String(sum((x) => x.rebalances)).padEnd(6)} ${("$" + sum((x) => x.costsUsd).toFixed(2)).padEnd(8)} ` +
        `${(net < 0 ? "-$" : "+$") + Math.abs(net).toFixed(2)}`,
    );
  }
}
store.close();
