import { loadConfig } from "../config/load.js";
import { makeClient } from "../chain/client.js";
import { Store } from "../data/store.js";
import { scanPools } from "../data/scanner.js";
import { discoverAeroPricing } from "../scoring/emissions.js";
import { fetchHistory } from "./history.js";
import { runBacktest } from "./backtest.js";
import { buildHistoricalRegimeOracle } from "../scoring/regime.js";

/**
 * Regime-threshold sweep with a TRAIN/HELD-OUT split — picks min_ratio without
 * fooling ourselves. Recent 5 months (m0-m4) is the "train" half (it informed
 * the strategy tuning); the older 5 months (m5-m9) are HELD OUT — never seen by
 * any tuning. A min_ratio is only trustworthy if it's good on the held-out half
 * too, not just the half it might be fit to. We report both halves for every
 * threshold so the choice is transparent, not cherry-picked.
 */

const cfg = loadConfig("config.yaml");
const client = makeClient(cfg);
const store = new Store(cfg.db.path);

const WINDOWS = Array.from({ length: 10 }, (_, i) => ({
  label: `m${i}`,
  days: 30,
  endDaysAgo: i * 30,
}));
const STEP = 6;
const RATIOS = [0, 0.3, 0.45, 0.6, 0.75, 0.9]; // 0 = gate effectively OFF
const TRAIN = new Set([0, 1, 2, 3, 4]); // recent — informed tuning
// held-out = 5..9 (older months, never seen by tuning)

const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
const aero = await discoverAeroPricing(client, cfg);
const gas = { gasPriceWei: await client.getGasPrice(), ethUsd: pricesUsd["WETH"]! };

// Fetch each window's history once (cached), reused across all thresholds.
const hists: Awaited<ReturnType<typeof fetchHistory>>[] = [];
for (const w of WINDOWS) {
  hists.push(await fetchHistory(cfg, client, store, snapshots, aero, { days: w.days, stepHours: STEP, endDaysAgo: w.endDaysAgo }, () => {}));
}
// One oracle per threshold (each fetches DefiLlama once).
const oracles = new Map<number, (p: string, t: number) => boolean>();
for (const r of RATIOS) if (r > 0) oracles.set(r, await buildHistoricalRegimeOracle(cfg.regime.baseline_lookback_days, r));

function run(ratio: number) {
  const oracle = ratio > 0 ? oracles.get(ratio) : undefined;
  const per = hists.map((h, i) => {
    const res = runBacktest(cfg, store, h, gas, () => {}, { regimeOracle: oracle });
    const net = res.finalEquityUsd - res.startCapitalUsd;
    const rows = res.entries;
    const wsum = rows.reduce((a, e) => a + Math.min(Math.max(e.daysHeld, 0.01), 7), 0);
    const sign = wsum
      ? rows.reduce((a, e) => a + (Math.sign(e.realizedAlphaUsdH) === Math.sign(e.predictedNetUsdH) ? Math.min(Math.max(e.daysHeld, 0.01), 7) : 0), 0) / wsum
      : 0;
    return { i, net, n: rows.length, sign, wsum };
  });
  const agg = (idx: number[]) => {
    const sel = per.filter((p) => idx.includes(p.i));
    const sum = sel.reduce((a, p) => a + p.net, 0);
    const worst = Math.min(...sel.map((p) => p.net));
    const wsum = sel.reduce((a, p) => a + p.wsum, 0);
    const sign = wsum ? sel.reduce((a, p) => a + p.sign * p.wsum, 0) / wsum : 0;
    const pos = sel.filter((p) => p.net > 0).length;
    return { sum, worst, sign, pos, n: sel.length };
  };
  return {
    train: agg([0, 1, 2, 3, 4]),
    held: agg([5, 6, 7, 8, 9]),
    all: agg([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  };
}

console.log(`Regime-threshold sweep (step ${STEP}h, 10x30d). TRAIN=m0-m4 (recent), HELD-OUT=m5-m9 (older, unseen).\n`);
const fmt = (a: { sum: number; worst: number; sign: number; pos: number; n: number }) =>
  `net ${a.sum >= 0 ? "+" : ""}$${a.sum.toFixed(0).padStart(5)}  worst ${a.worst >= 0 ? "+" : ""}$${a.worst.toFixed(0).padStart(4)}  ${(a.sign * 100).toFixed(0)}%  ${a.pos}/${a.n}pos`;
console.log("min_ratio   TRAIN (recent)                          HELD-OUT (older, unseen)");
for (const r of RATIOS) {
  const x = run(r);
  console.log(`${(r === 0 ? "OFF" : r.toFixed(2)).padEnd(9)}  ${fmt(x.train)}     ${fmt(x.held)}`);
}
console.log("\nPick the threshold that is strong on HELD-OUT (not just TRAIN). 'worst' = worst single month (drawdown control).");
