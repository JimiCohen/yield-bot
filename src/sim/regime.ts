import { loadConfig } from "../config/load.js";
import { refreshRegimeBaseline, classifyHistory, isRegimeFavorable, REGIME_UUIDS } from "../scoring/regime.js";

/**
 * Emission-regime report + the gate's honest validation.
 *
 * Top: current per-pool status (DEPLOY / STAND DOWN) from the live baseline.
 * Bottom: month-by-month, what the gate WOULD have done over ~11 months —
 * the validation that it rides high-emission spikes and stands down when carry
 * fades (no-lookahead: each month judged on the trailing median up to it).
 *
 * Granular net-alpha backtest months back still needs an archive RPC (public
 * Base endpoints prune state); this regime layer is the months-scale guard we
 * CAN build from free data today.
 */

const cfg = loadConfig("config.yaml");
const PAIRS = ["WETH/USDC", "USDC/cbBTC", "WETH/cbBTC", "SOL/USDC"];

console.log("Refreshing regime baseline (DefiLlama, ~11mo, no key)...\n");
const b = await refreshRegimeBaseline(cfg, (m) => console.log("  " + m));
console.log(
  `\n== CURRENT REGIME (min_ratio ${cfg.regime.min_ratio}, lookback ${cfg.regime.baseline_lookback_days}d) ==`,
);
console.log("pair         emisAPY now   11mo-median   ratio   decision");
for (const pair of PAIRS) {
  const s = b.pairs[pair];
  if (!s) continue;
  const r = isRegimeFavorable(cfg, b, pair, Date.now());
  console.log(
    `${pair.padEnd(11)}  ${(s.currentApy.toFixed(0) + "%").padStart(10)}   ${(s.medianApy.toFixed(0) + "%").padStart(10)}   ${s.ratio.toFixed(2).padStart(5)}   ${r.favorable ? "✅ DEPLOY" : "🛑 STAND DOWN"}`,
  );
}

console.log("\n== GATE VALIDATION: month-by-month over ~11mo (no lookahead) ==");
for (const pair of PAIRS) {
  if (!REGIME_UUIDS[pair]) continue;
  const hist = await classifyHistory(pair, cfg.regime.baseline_lookback_days, cfg.regime.min_ratio);
  const deployed = hist.filter((h) => h.deploy).length;
  console.log(`\n${pair} — would deploy ${deployed}/${hist.length} months:`);
  const line = hist
    .map((h) => `${h.month.slice(2)}:${h.deploy ? "✅" : "🛑"}`)
    .join("  ");
  console.log("  " + line);
}
console.log(
  "\nThe gate RIDES high-emission months (✅) and STANDS DOWN when a pool's\n" +
    "emissions fade below its trailing baseline (🛑) — turning a spike-dependent\n" +
    "carry into an explicit, automated rule. It fails open on missing/stale data.",
);
