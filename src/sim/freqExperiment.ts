import { loadConfig } from "../config/load.js";
import { makeClient } from "../chain/client.js";
import { Store } from "../data/store.js";
import { scanPools } from "../data/scanner.js";
import { discoverAeroPricing } from "../scoring/emissions.js";
import { fetchHistory, type History } from "./history.js";
import { runBacktest } from "./backtest.js";

/**
 * Rebalance-frequency experiment.
 *
 * Question: with Base gas near zero and high in-range APR, does rebalancing
 * every 5/10/30/60 minutes beat the conservative cadence?
 *
 * Method: ONE history fetch at 5-minute granularity (so every variant
 * replays the IDENTICAL market — same actual emissions, fee growth, and
 * AERO price path), then four no-lookahead replays that differ only in
 * check cadence (via subsampling) with the rate-limit and sustain gates
 * opened to match each cadence. The optimizer is allowed to choose widths
 * as tight as the cadence supports — that is the point: high frequency
 * licenses tight ranges, and tight ranges trade more fee/emission density
 * against more LVR and churn. The replay decides who wins with real data.
 */

const DAYS = 3;
const FINE_STEP_HOURS = 5 / 60;

function subsample(hist: History, k: number): History {
  return {
    ...hist,
    blocks: hist.blocks.filter((_, i) => i % k === 0),
  };
}

const cfg = loadConfig("config.yaml");
const client = makeClient(cfg);
const store = new Store(cfg.db.path);
const log = (m: string) => console.log(m);

console.log(`Frequency experiment: ${DAYS}d window @ 5-minute samples (one fetch, four replays)`);
const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
const aero = await discoverAeroPricing(client, cfg);
const ethUsd = pricesUsd["WETH"];
if (!ethUsd) throw new Error("no WETH price");
const gas = { gasPriceWei: await client.getGasPrice(), ethUsd };

const hist = await fetchHistory(
  cfg, client, store, snapshots, aero,
  { days: DAYS, stepHours: FINE_STEP_HOURS }, log,
);

const variants = [
  { label: "5 min", k: 1 },
  { label: "10 min", k: 2 },
  { label: "30 min", k: 6 },
  { label: "60 min", k: 12 },
];

interface Row {
  label: string;
  entries: number;
  rebalances: number;
  netUsd: number;
  alphaUsd: number;
  costsUsd: number;
  finalEquity: number;
}
const rows: Row[] = [];

for (const v of variants) {
  const minutes = v.k * 5;
  const cfgV = structuredClone(cfg);
  // Open the operational gates to match the cadence under test: allow a
  // rebalance at every check, no sustain delay. Deadband and the
  // net-benefit margin stay — removing those would test thrashing, not
  // frequency.
  cfgV.rebalance.max_rebalances_per_day = Math.ceil(1440 / minutes);
  cfgV.rebalance.sustain_minutes = 0;
  console.log(`\n=== ${v.label} cadence (max ${cfgV.rebalance.max_rebalances_per_day} rebal/day, forced allocation) ===`);
  // forceEntry + forceWidthMult ±1%: always hold the best pool at a TIGHT
  // range. Prior runs showed (a) nothing clears the entry bar this window
  // at any cadence, and (b) the optimizer always picks the widest range
  // (tight = NEY-negative), making all cadences identical. Pinning a tight
  // width is the only way the band actually exits range and the cadences
  // must manage it — this measures the user's hypothesis directly.
  const res = runBacktest(cfgV, store, subsample(hist, v.k), gas, log, {
    forceEntry: true,
    forceWidthMult: 1.01,
  });
  rows.push({
    label: v.label,
    entries: res.entries.length,
    rebalances: res.entries.reduce((a, e) => a + e.rebalances, 0),
    netUsd: res.finalEquityUsd - res.startCapitalUsd,
    alphaUsd: res.entries.reduce((a, e) => a + e.realizedAlphaUsd, 0),
    costsUsd: res.totalCostsUsd,
    finalEquity: res.finalEquityUsd,
  });
}

console.log(`\n${"CADENCE".padEnd(9)} ${"ENTRIES".padEnd(8)} ${"REBALANCES".padEnd(11)} ${"COSTS".padEnd(9)} ${"RAW PnL".padEnd(10)} ${"ALPHA (vs hodl)".padEnd(16)} FINAL EQUITY`);
for (const r of rows) {
  console.log(
    `${r.label.padEnd(9)} ${String(r.entries).padEnd(8)} ${String(r.rebalances).padEnd(11)} ` +
      `${("$" + r.costsUsd.toFixed(2)).padEnd(9)} ${((r.netUsd >= 0 ? "+$" : "-$") + Math.abs(r.netUsd).toFixed(2)).padEnd(10)} ` +
      `${((r.alphaUsd >= 0 ? "+$" : "-$") + Math.abs(r.alphaUsd).toFixed(2)).padEnd(16)} $${r.finalEquity.toFixed(2)}`,
  );
}
console.log(
  "\nALPHA = LP result minus holding the same inventory (strips market direction —" +
    "\nthe number rebalancing frequency can actually influence). RAW PnL includes beta.",
);
store.close();
