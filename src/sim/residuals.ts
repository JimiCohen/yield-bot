import { loadConfig } from "../config/load.js";
import { makeClient } from "../chain/client.js";
import { Store } from "../data/store.js";
import { scanPools } from "../data/scanner.js";
import { discoverAeroPricing } from "../scoring/emissions.js";
import { fetchHistory } from "./history.js";
import { runBacktest, type BacktestEntryResult } from "./backtest.js";
import { buildHistoricalRegimeOracle } from "../scoring/regime.js";

/**
 * Residual analyzer — the quant diagnostic, not a strategy.
 *
 * Decomposes prediction error TERM BY TERM so we fix the right thing instead
 * of guessing. For every backtest entry it compares:
 *   predicted gross (emissions/fees)  vs  realized yield (emissions + fees)
 *   predicted LVR (divergence)        vs  realized divergence
 *   predicted net                     vs  realized alpha
 * where realized divergence is backed out exactly:
 *   alpha = yield - costs - divergence   =>   divergence = yield - costs - alpha
 *
 * Runs across MULTIPLE history windows (endDaysAgo) so any fix is judged
 * out-of-sample, not fit to one 30-day regime.
 */

const cfg = loadConfig("config.yaml");
const client = makeClient(cfg);
const store = new Store(cfg.db.path);

// Robustness sweep across MONTHS (archive RPC backfills these). Non-overlapping
// 30d windows stepping back ~6 months — judges the strategy across many regimes,
// not one lucky period. Set BASE_ARCHIVE_RPC for depth.
const WINDOWS = [
  { label: "m0 (0-30d)", days: 30, endDaysAgo: 0 },
  { label: "m1 (30-60d)", days: 30, endDaysAgo: 30 },
  { label: "m2 (60-90d)", days: 30, endDaysAgo: 60 },
  { label: "m3 (90-120d)", days: 30, endDaysAgo: 90 },
  { label: "m4 (120-150d)", days: 30, endDaysAgo: 120 },
];
const STEP_OVERRIDE = 6; // hours; coarser keeps the deep sweep within RPC budget
const STEP_HOURS = STEP_OVERRIDE;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function corr(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxy / (Math.sqrt(sxx * syy) || 1);
}

/** Per-entry realized decomposition, all scaled to the horizon for parity
 *  with the predicted/horizon figures. */
function decompose(e: BacktestEntryResult, H: number) {
  const scale = H / Math.max(e.daysHeld, 1e-9);
  const realizedYield = (e.feesUsd + e.emissionsUsd) * scale;
  const realizedAlpha = e.realizedAlphaUsdH;
  const realizedCosts = e.costsUsd * scale;
  // alpha = yield - costs - divergence  =>  divergence = yield - costs - alpha
  const realizedDivergence = realizedYield - realizedCosts - realizedAlpha;
  return {
    predGross: e.predictedGrossUsdH,
    predLvr: e.predictedLvrUsdH,
    predNet: e.predictedNetUsdH,
    realizedYield,
    realizedDivergence,
    realizedAlpha,
    widthPct: (e.widthMult - 1) * 100,
    daysHeld: e.daysHeld,
  };
}

const all: ReturnType<typeof decompose>[] = [];

console.log(`Residual analysis — term-by-term, ${WINDOWS.length} windows (REGIME_OFF=${!!process.env.REGIME_OFF})\n`);
const snapshotsAero = await (async () => {
  const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
  const aero = await discoverAeroPricing(client, cfg);
  const ethUsd = pricesUsd["WETH"]!;
  const gas = { gasPriceWei: await client.getGasPrice(), ethUsd };
  return { snapshots, aero, gas };
})();

// As-of regime oracle (no lookahead) so the backtest applies the SAME gate the
// live bot uses. Disable with REGIME_OFF=1 to A/B its value.
const oracle = process.env.REGIME_OFF
  ? undefined
  : await buildHistoricalRegimeOracle(cfg.regime.baseline_lookback_days, cfg.regime.min_ratio);

let totalNet = 0;
for (const w of WINDOWS) {
  const hist = await fetchHistory(
    cfg, client, store, snapshotsAero.snapshots, snapshotsAero.aero,
    { days: w.days, stepHours: STEP_HOURS, endDaysAgo: w.endDaysAgo },
    () => {},
  );
  const res = runBacktest(cfg, store, hist, snapshotsAero.gas, () => {}, { regimeOracle: oracle });
  const H = cfg.scoring.horizon_days;
  const rows = res.entries.map((e) => decompose(e, H));
  all.push(...rows);
  const ret = res.finalEquityUsd - res.startCapitalUsd;
  totalNet += ret;
  console.log(
    `[${w.label}] ${rows.length} entries | net ${ret >= 0 ? "+" : ""}$${ret.toFixed(2)} | ` +
      `sign-agree ${(100 * rows.filter((r) => Math.sign(r.realizedAlpha) === Math.sign(r.predNet)).length / (rows.length || 1)).toFixed(0)}%`,
  );
}
console.log(`\nSUM net across all windows: ${totalNet >= 0 ? "+" : ""}$${totalNet.toFixed(2)}`);

if (all.length === 0) {
  console.log("\nNo entries produced — nothing to analyze.");
  process.exit(0);
}

const g = all.map((r) => r.predGross);
const ry = all.map((r) => r.realizedYield);
const pl = all.map((r) => r.predLvr);
const rd = all.map((r) => r.realizedDivergence);
const pn = all.map((r) => r.predNet);
const ra = all.map((r) => r.realizedAlpha);

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
console.log(`\n=== POOLED (${all.length} entries across all windows) ===`);
console.log("term            predicted_mean  realized_mean   bias(real/pred)  corr");
console.log(
  `yield (gross)   ${fmt(mean(g)).padStart(14)}  ${fmt(mean(ry)).padStart(13)}  ${fmt(mean(ry) / mean(g)).padStart(15)}  ${fmt(corr(g, ry))}`,
);
console.log(
  `divergence/LVR  ${fmt(mean(pl)).padStart(14)}  ${fmt(mean(rd)).padStart(13)}  ${fmt(mean(rd) / mean(pl)).padStart(15)}  ${fmt(corr(pl, rd))}`,
);
console.log(
  `NET vs ALPHA    ${fmt(mean(pn)).padStart(14)}  ${fmt(mean(ra)).padStart(13)}  ${fmt(mean(ra) / mean(pn)).padStart(15)}  ${fmt(corr(pn, ra))}`,
);
console.log(
  `\nsign agreement (net vs alpha): ${(100 * all.filter((r) => Math.sign(r.realizedAlpha) === Math.sign(r.predNet)).length / all.length).toFixed(0)}%`,
);

// Where does the loss concentrate? Bucket by width.
console.log("\n=== by width bucket ===");
console.log("width        n    pred_net  real_alpha  yield_bias  div_bias");
const buckets = [
  { label: "≤0.3%", lo: 0, hi: 0.3 },
  { label: "0.3-0.6%", lo: 0.3, hi: 0.6 },
  { label: "0.6-1.2%", lo: 0.6, hi: 1.2 },
  { label: ">1.2%", lo: 1.2, hi: 1e9 },
];
for (const b of buckets) {
  const rows = all.filter((r) => r.widthPct > b.lo && r.widthPct <= b.hi);
  if (!rows.length) continue;
  console.log(
    `${b.label.padEnd(11)} ${String(rows.length).padStart(3)}  ${fmt(mean(rows.map((r) => r.predNet))).padStart(8)}  ${fmt(mean(rows.map((r) => r.realizedAlpha))).padStart(10)}  ` +
      `${fmt(mean(rows.map((r) => r.realizedYield)) / mean(rows.map((r) => r.predGross))).padStart(10)}  ${fmt(mean(rows.map((r) => r.realizedDivergence)) / mean(rows.map((r) => r.predLvr))).padStart(8)}`,
  );
}
console.log("\nbias > 1 = model UNDER-predicts that term; bias < 1 = OVER-predicts.");
console.log("The term whose bias is farthest from 1.0 (esp. with low corr) is the one to fix.");
