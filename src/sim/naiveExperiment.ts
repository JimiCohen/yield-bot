import { loadConfig } from "../config/load.js";
import { makeClient } from "../chain/client.js";
import { Store } from "../data/store.js";
import { scanPools } from "../data/scanner.js";
import { discoverAeroPricing } from "../scoring/emissions.js";
import { fetchHistory } from "./history.js";
import { runBacktest } from "./backtest.js";

/**
 * The "9,000% APR if in range" test.
 *
 * Simulates the naive policy directly: allocate to the high-emission
 * USDC/cbBTC pool at a tight width, check every 5 minutes, and recenter
 * EVERY time the band is exited (no rate limit, no net-benefit gate) —
 * over the real last 3 days of on-chain data: actual gauge emissions,
 * actual fee growth, actual AERO prices, actual gas.
 *
 * Decomposition printed per run: emissions collected vs. value change
 * (the divergence the rebalances lock in) vs. costs. The point is to make
 * "in-range APR" and "cost of staying in range" visible side by side.
 */

const DAYS = 3;
const STEP_HOURS = 5 / 60;

const cfg = loadConfig("config.yaml");
const client = makeClient(cfg);
const store = new Store(cfg.db.path);
const log = (m: string) => console.log(m);

const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
const aero = await discoverAeroPricing(client, cfg);
const ethUsd = pricesUsd["WETH"]!;
const gas = { gasPriceWei: await client.getGasPrice(), ethUsd };

const hist = await fetchHistory(
  cfg, client, store, snapshots, aero, { days: DAYS, stepHours: STEP_HOURS }, log,
);

for (const width of [1.005, 1.02]) {
  const cfgV = structuredClone(cfg);
  cfgV.rebalance.sustain_minutes = 0;
  cfgV.rebalance.max_rebalances_per_day = 999;
  console.log(`\n=== USDC/cbBTC, ±${((width - 1) * 100).toFixed(1)}%, recenter at every out-of-range check (5-min checks) ===`);
  const res = runBacktest(cfgV, store, hist, gas, log, {
    forceEntry: true,
    forcePool: "USDC/cbBTC",
    forceWidthMult: width,
    forceRebalance: true,
  });
  const e = res.entries;
  const sum = (f: (x: (typeof e)[0]) => number) => e.reduce((a, x) => a + f(x), 0);
  console.log(
    `  TOTAL: emissions+fees collected $${(sum((x) => x.emissionsUsd) + sum((x) => x.feesUsd)).toFixed(2)} | ` +
      `value change $${sum((x) => x.valueChangeUsd).toFixed(2)} | costs $${sum((x) => x.costsUsd).toFixed(2)} | ` +
      `rebalances ${sum((x) => x.rebalances)} | net $${(res.finalEquityUsd - res.startCapitalUsd).toFixed(2)} ` +
      `(~${(((res.finalEquityUsd - res.startCapitalUsd) / res.startCapitalUsd) * (365 / res.daysSimulated) * 100).toFixed(0)}% APR) | ` +
      `alpha $${sum((x) => x.realizedAlphaUsd).toFixed(2)}`,
  );
}
store.close();
