import Database from "better-sqlite3";
import { loadConfig } from "../config/load.js";

/**
 * Validation-gate progress report (read-only). Mirrors EXACTLY the gate the
 * live command enforces (store.getValidationStats / server validationStats):
 * hold-time-weighted sign agreement + clamped ratio over the paper ledger.
 * Prints where the ledger stands, an ETA from the recent fill rate, and a loud
 * banner the day all three criteria pass. Safe to run anytime / on a schedule.
 */

const cfg = loadConfig(process.argv[2] ?? "config.yaml");
const db = new Database(cfg.db.path, { readonly: true });
const e = cfg.execution;

type Row = { p: number; r: number; d: number; exit_ts: number; pair: string };
const rows = db
  .prepare(
    "SELECT predicted_net_usd_h p, realized_alpha_usd_h r, days_held d, exit_ts, pair FROM paper_entries ORDER BY exit_ts",
  )
  .all() as Row[];

const w = (d: number) => Math.min(Math.max(d, 0.01), 7);
function stats(rs: Row[]) {
  if (!rs.length) return { n: 0, sign: 0, ratio: NaN };
  const wSum = rs.reduce((a, x) => a + w(x.d), 0);
  const sign = rs.reduce((a, x) => a + (Math.sign(x.r) === Math.sign(x.p) ? w(x.d) : 0), 0) / wSum;
  const rated = rs.filter((x) => Math.abs(x.p) > 0.5);
  const rwSum = rated.reduce((a, x) => a + w(x.d), 0);
  const ratio = rated.length
    ? rated.reduce((a, x) => a + Math.max(-5, Math.min(5, x.r / x.p)) * w(x.d), 0) / rwSum
    : NaN;
  return { n: rs.length, sign, ratio };
}

const s = stats(rows);
const cEntries = s.n >= e.validation_min_entries;
const cSign = s.sign >= e.validation_min_sign_agreement;
const cRatio = Number.isFinite(s.ratio) && s.ratio >= e.validation_ratio_min && s.ratio <= e.validation_ratio_max;
const passed = cEntries && cSign && cRatio;

const realizedUsd = (db.prepare("SELECT COALESCE(SUM(realized_net_usd),0) s FROM paper_entries").get() as { s: number }).s;
const openN = (db.prepare("SELECT COUNT(*) n FROM paper_positions WHERE status='open'").get() as { n: number }).n;

// Fill rate / ETA from the last 5 days of closes.
const nowS = rows.length ? rows[rows.length - 1]!.exit_ts : 0;
const since = nowS - 5 * 86_400_000;
const recent = rows.filter((x) => x.exit_ts >= since).length;
const perDay = recent / 5;
const remaining = Math.max(0, e.validation_min_entries - s.n);
const etaDays = perDay > 0 ? remaining / perDay : Infinity;

const mark = (ok: boolean) => (ok ? "✅" : "⏳");
const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "n/a");

console.log(`\n=== YIELD BOT — validation gate progress (${cfg.chain.id === 10 ? "Velodrome" : "Aerodrome"}) ===`);
console.log(`paper P&L so far: ${realizedUsd >= 0 ? "+" : ""}$${realizedUsd.toFixed(2)} realized · ${openN} open`);
console.log("");
console.log(`${mark(cEntries)} test trades        ${s.n} / ${e.validation_min_entries}`);
console.log(`${mark(cSign)} prediction accuracy ${pct(s.sign)}  (need ${pct(e.validation_min_sign_agreement)})`);
console.log(`${mark(cRatio)} returns realistic   ${Number.isFinite(s.ratio) ? s.ratio.toFixed(2) + "x" : "n/a"}  (need ${e.validation_ratio_min}-${e.validation_ratio_max}x)`);
console.log("");
if (passed) {
  console.log("🟢🟢🟢 GATE GREEN — the strategy is validated on live paper data.");
  console.log("Real money is UNLOCKED (still requires: dedicated wallet, funds, key in env, mode: live).");
  console.log("See GO-LIVE.md. First live deploy is capped at $" + (cfg.position.max_position_usd ?? "?") + "/position.");
} else if (!cEntries) {
  console.log(
    `🔶 Building evidence: ${remaining} more test trade(s) needed. ` +
      (Number.isFinite(etaDays)
        ? `At ${perDay.toFixed(1)}/day → ~${Math.ceil(etaDays)} day(s) to the minimum.`
        : "No recent closes — check the paper bot is running."),
  );
} else {
  console.log("🔶 Enough trades, but accuracy/returns not yet clearing the bar. The bot keeps");
  console.log("   practicing; real money stays locked. (This is the safety system working.)");
}

// Per-pool contribution (what's actually earning).
const byPair = db
  .prepare(
    "SELECT pair, COUNT(*) n, ROUND(SUM(realized_net_usd),2) net FROM paper_entries GROUP BY pair ORDER BY net DESC",
  )
  .all() as { pair: string; n: number; net: number }[];
if (byPair.length) {
  console.log("\nby pool:  " + byPair.map((x) => `${x.pair} ${x.net >= 0 ? "+" : ""}$${x.net}(${x.n})`).join("  ·  "));
}
db.close();

// Exit code 0 = green (for schedulers that branch on it), 10 = still working.
process.exit(passed ? 0 : 10);
