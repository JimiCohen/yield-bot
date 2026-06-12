import { loadConfig } from "../config/load.js";
import { makeClient } from "../chain/client.js";
import { Store } from "../data/store.js";
import { scanPools } from "../data/scanner.js";
import { discoverAeroPricing } from "../scoring/emissions.js";
import { fetchHistory, type History } from "./history.js";
import { runBacktest } from "./backtest.js";

/**
 * RIGOROUS check-cadence sweep. Finds the best "how often to check" by
 * sweeping many cadences on the key pools across TWO different market
 * windows (recent + ~2 weeks ago) so the answer isn't overfit to one
 * regime. The strategy is the real gated one (gates decide rebalances).
 */

const PLAYS = [
  { pool: "0x9d14ff91ae2c6e3d1a760542248b6c7f206894b0", label: "USDC/cbBTC", amount: 400, width: 1.0001 },
  { pool: "0x1131db5977242a03ebead1acd18f80a9a29e5922", label: "SOL/USDC", amount: 1000, width: 1.0005 },
];
const CADENCES = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const WINDOWS = [
  { label: "recent 3d", endDaysAgo: 0 },
  { label: "~14d ago 3d", endDaysAgo: 12 },
];
const DAYS = 3;
const STEP_HOURS = 5 / 60;

const cfg = loadConfig("config.yaml");
const client = makeClient(cfg);
const store = new Store(cfg.db.path);

const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
const aero = await discoverAeroPricing(client, cfg);
const gas = { gasPriceWei: await client.getGasPrice(), ethUsd: pricesUsd["WETH"]! };

function runOn(hist: History, play: (typeof PLAYS)[0], minutes: number) {
  const cfgV = structuredClone(cfg);
  cfgV.capital_usdc = play.amount;
  cfgV.position.min_position_usd = play.amount;
  cfgV.position.max_pool_fraction = 1.0;
  cfgV.rebalance.check_interval_minutes = minutes;
  cfgV.rebalance.sustain_minutes = 0;
  cfgV.rebalance.min_hold_minutes = 0;
  cfgV.rebalance.max_rebalances_per_day = Math.ceil(1440 / minutes);
  const stepK = Math.max(1, Math.round(minutes / (STEP_HOURS * 60)));
  const sub = { ...hist, blocks: hist.blocks.filter((_, i) => i % stepK === 0) };
  const res = runBacktest(cfgV, store, sub, gas, () => {}, {
    forceEntry: true,
    forcePool: play.pool,
    forceWidthMult: play.width,
  });
  const net = res.finalEquityUsd - res.startCapitalUsd;
  const rebal = res.entries.reduce((a, e) => a + e.rebalances, 0);
  return { perDay: net / res.daysSimulated, rebal };
}

for (const w of WINDOWS) {
  console.log(`\n=== WINDOW: ${w.label} (fetching 5-min history) ===`);
  const hist = await fetchHistory(
    cfg, client, store, snapshots, aero,
    { days: DAYS, stepHours: STEP_HOURS, endDaysAgo: w.endDaysAgo },
    (m) => console.log("  " + m),
  );
  for (const play of PLAYS) {
    const cells = CADENCES.map((m) => ({ m, ...runOn(hist, play, m) }));
    const best = cells.reduce((a, b) => (b.perDay > a.perDay ? b : a));
    console.log(`\n  ${play.label} ($${play.amount}):`);
    console.log(
      "  " +
        cells
          .map((c) => `${c.m}m:${(c.perDay >= 0 ? "+" : "") + c.perDay.toFixed(1)}(${c.rebal}r)`)
          .join("  "),
    );
    console.log(`  >> best check interval: ${best.m} min (${best.perDay >= 0 ? "+" : ""}$${best.perDay.toFixed(2)}/day, ${best.rebal} rebalances)`);
  }
}
console.log("\nFormat: <cadence>m:<net $/day>(<rebalances>). Higher $/day = better.");
store.close();
