import { loadConfig } from "../config/load.js";
import { makeClient } from "../chain/client.js";
import { Store } from "../data/store.js";
import { scanPools } from "../data/scanner.js";
import { discoverAeroPricing } from "../scoring/emissions.js";
import { fetchHistory } from "./history.js";
import { runBacktest } from "./backtest.js";

/**
 * The definitive strategy table. For each top pool, over the real recent
 * window, at its optimal amount and tight width, runs the strategy and
 * reports the FULL honest economics:
 *   headline reward APR  → what DeFiLlama/UI advertise (gross, in-range)
 *   prizes collected     → emissions+fees actually earned ($)
 *   costs                → gas + swaps + recentering ($)
 *   NET                  → what you actually keep ($)
 *   $/day, $/week, $/mo  → net run-rate
 *   net APR              → net annualized on the capital used
 *
 * Two rebalance cadences shown so the frequency question is answered with
 * numbers. All on real on-chain history — no invented data.
 */

const PLAYS = [
  { pool: "0x9d14ff91ae2c6e3d1a760542248b6c7f206894b0", label: "USDC/cbBTC", amount: 400, width: 1.0001 },
  { pool: "0x1131db5977242a03ebead1acd18f80a9a29e5922", label: "SOL/USDC", amount: 1000, width: 1.0005 },
  { pool: "0x4e392fbfe4d0557c82d2f97f02ec39daa31516dd", label: "WETH/USDC", amount: 400, width: 1.0001 },
];
const CADENCES = [
  { label: "5 min checks", minutes: 5 },
  { label: "30 min checks", minutes: 30 },
];
const DAYS = 3;
const STEP_HOURS = 5 / 60;

const cfg = loadConfig("config.yaml");
const client = makeClient(cfg);
const store = new Store(cfg.db.path);

console.log(`Strategy table — gated strategy on real ${DAYS}d on-chain history (Aerodrome/Base)\n`);
const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
const aero = await discoverAeroPricing(client, cfg);
const gas = { gasPriceWei: await client.getGasPrice(), ethUsd: pricesUsd["WETH"]! };
const hist = await fetchHistory(cfg, client, store, snapshots, aero, { days: DAYS, stepHours: STEP_HOURS }, (m) => console.log(m));

const rows: string[] = [];
rows.push(
  `${"POOL".padEnd(12)} ${"AMOUNT".padEnd(7)} ${"CADENCE".padEnd(14)} ${"PRIZES".padEnd(9)} ${"COSTS".padEnd(8)} ${"REBAL".padEnd(6)} ${"NET/day".padEnd(9)} ${"NET/wk".padEnd(9)} ${"NET/mo".padEnd(9)} NET APR`,
);
for (const play of PLAYS) {
  for (const c of CADENCES) {
    const cfgV = structuredClone(cfg);
    cfgV.capital_usdc = play.amount;
    cfgV.position.min_position_usd = play.amount;
    cfgV.position.max_pool_fraction = 1.0;
    cfgV.rebalance.check_interval_minutes = c.minutes;
    cfgV.rebalance.sustain_minutes = 0;
    cfgV.rebalance.min_hold_minutes = 0;
    cfgV.rebalance.max_rebalances_per_day = Math.ceil(1440 / c.minutes);
    const stepK = Math.max(1, Math.round(c.minutes / (STEP_HOURS * 60)));
    const subHist = { ...hist, blocks: hist.blocks.filter((_, i) => i % stepK === 0) };
    const res = runBacktest(cfgV, store, subHist, gas, () => {}, {
      forceEntry: true,
      forcePool: play.pool,
      forceWidthMult: play.width,
      // gates decide rebalances (NOT forceRebalance) — the real strategy
    });
    const e = res.entries;
    const sum = (f: (x: (typeof e)[0]) => number) => e.reduce((a, x) => a + f(x), 0);
    const net = res.finalEquityUsd - res.startCapitalUsd;
    const days = res.daysSimulated;
    const perDay = net / days;
    rows.push(
      `${play.label.padEnd(12)} ${("$" + play.amount).padEnd(7)} ${c.label.padEnd(14)} ` +
        `${("$" + (sum((x) => x.emissionsUsd) + sum((x) => x.feesUsd)).toFixed(2)).padEnd(9)} ` +
        `${("$" + sum((x) => x.costsUsd).toFixed(2)).padEnd(8)} ${String(sum((x) => x.rebalances)).padEnd(6)} ` +
        `${((perDay < 0 ? "-$" : "+$") + Math.abs(perDay).toFixed(2)).padEnd(9)} ` +
        `${((perDay * 7 < 0 ? "-$" : "+$") + Math.abs(perDay * 7).toFixed(2)).padEnd(9)} ` +
        `${((perDay * 30 < 0 ? "-$" : "+$") + Math.abs(perDay * 30).toFixed(2)).padEnd(9)} ` +
        `${((perDay / play.amount) * 365 * 100).toFixed(0)}%`,
    );
  }
}
console.log("\n" + rows.join("\n"));
console.log(
  "\nPRIZES = emissions+fees collected. NET = prizes − costs − divergence (LVR).\n" +
    "Net run-rate extrapolated from the real window; actual varies with market chop vs trend.",
);
store.close();
