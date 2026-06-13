import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config/schema.js";

/**
 * Emission-REGIME awareness.
 *
 * The strategy harvests emission carry. 11 months of DefiLlama history show
 * that carry is volatile and mean-reverting: high for stretches, thin for
 * others. Backtests on a high-emission month look great; the same strategy
 * BLEEDS in low-emission months (divergence > carry). So we gate on regime —
 * RIDE the spike, STAND DOWN when a pool's emissions collapse below its own
 * baseline. This is deliberately NOT a haircut on spikes (spikes are when you
 * earn); it only refuses pools whose emissions have faded.
 *
 * Source: DefiLlama yields (free, ~11mo daily). Baseline is cached to disk and
 * refreshed by the live cycle / `npm run regime`; the gate fails OPEN (treats
 * a pool as favorable) when data is missing or stale, since it is a profit
 * enhancement, not a safety gate.
 */

// DefiLlama pool UUIDs for the configured pairs (the deepest/longest-history
// gauge pool per pair). Verified 2026-06-13 via yields.llama.fi/pools.
const UUID: Record<string, string> = {
  "WETH/USDC": "10137e20-efbc-4e15-a733-17ecb52c48e8",
  "USDC/WETH": "10137e20-efbc-4e15-a733-17ecb52c48e8",
  "USDC/cbBTC": "ff82c362-dea1-4946-b3b1-92ebd5100b1e",
  "cbBTC/USDC": "ff82c362-dea1-4946-b3b1-92ebd5100b1e",
  "WETH/cbBTC": "4943b6d2-aad2-4f4d-b56e-93f41ef043aa",
  "cbBTC/WETH": "4943b6d2-aad2-4f4d-b56e-93f41ef043aa",
  "SOL/USDC": "a6a1fe38-a220-4f68-a2b9-d2749c3e4664",
  "USDC/SOL": "a6a1fe38-a220-4f68-a2b9-d2749c3e4664",
};

export interface RegimeStatus {
  pair: string;
  currentApy: number; // last-7d median emission APY
  medianApy: number; // trailing-baseline median emission APY
  ratio: number; // current / median
  favorable: boolean; // ratio >= min_ratio
}

interface BaselineFile {
  asOf: number;
  lookbackDays: number;
  minRatio: number;
  pairs: Record<string, RegimeStatus>;
}

type LlamaPt = { timestamp: string; apyReward: number | null };
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : 0);

function cachePath(cfg: Config): string {
  return join(dirname(cfg.db.path), "regime-baseline.json");
}

async function fetchSeries(uuid: string): Promise<LlamaPt[]> {
  const r = await fetch(`https://yields.llama.fi/chart/${uuid}`);
  if (!r.ok) throw new Error(`DefiLlama ${uuid}: HTTP ${r.status}`);
  return ((await r.json()) as { data: LlamaPt[] }).data ?? [];
}

function statusFromSeries(pair: string, data: LlamaPt[], lookbackDays: number, minRatio: number): RegimeStatus {
  const rew = data.map((x) => x.apyReward ?? 0);
  const currentApy = med(rew.slice(-7));
  const medianApy = med(rew.slice(-lookbackDays));
  const ratio = medianApy > 0 ? currentApy / medianApy : currentApy > 0 ? Infinity : 1;
  return { pair, currentApy, medianApy, ratio, favorable: ratio >= minRatio };
}

/** Fetch DefiLlama, recompute per-pair regime status, write the cache. */
export async function refreshRegimeBaseline(cfg: Config, log: (m: string) => void): Promise<BaselineFile> {
  const lookbackDays = cfg.regime.baseline_lookback_days;
  const minRatio = cfg.regime.min_ratio;
  const pairs: Record<string, RegimeStatus> = {};
  const seen = new Set<string>();
  for (const pair of Object.keys(UUID)) {
    const canonical = pair; // store under every alias so lookup is direct
    if (seen.has(UUID[pair]!)) {
      // already fetched this uuid under another alias — copy status
      const src = Object.values(pairs).find((s) => UUID[s.pair] === UUID[pair]);
      if (src) pairs[canonical] = { ...src, pair: canonical };
      continue;
    }
    try {
      const data = await fetchSeries(UUID[pair]!);
      seen.add(UUID[pair]!);
      pairs[canonical] = statusFromSeries(canonical, data, lookbackDays, minRatio);
    } catch (e) {
      log(`regime: ${pair} fetch failed (${e instanceof Error ? e.message : e}) — will fail open`);
    }
  }
  // backfill aliases that pointed to an already-fetched uuid
  for (const pair of Object.keys(UUID)) {
    if (pairs[pair]) continue;
    const src = Object.values(pairs).find((s) => UUID[s.pair] === UUID[pair]);
    if (src) pairs[pair] = { ...src, pair };
  }
  const file: BaselineFile = { asOf: Date.now(), lookbackDays, minRatio, pairs };
  const p = cachePath(cfg);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2));
  return file;
}

export function loadRegimeBaseline(cfg: Config): BaselineFile | null {
  const p = cachePath(cfg);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BaselineFile;
  } catch {
    return null;
  }
}

/**
 * Is this pair in a favorable emission regime right now? Fails OPEN (true)
 * when the gate is disabled, the baseline is missing/stale, or the pair is
 * unmapped — a profit enhancement must never silently freeze the bot.
 */
export function isRegimeFavorable(
  cfg: Config,
  baseline: BaselineFile | null,
  pair: string,
  nowMs: number,
): { favorable: boolean; reason: string } {
  if (!cfg.regime.enabled) return { favorable: true, reason: "regime gate off" };
  if (!baseline) return { favorable: true, reason: "no baseline (fail-open)" };
  const ageH = (nowMs - baseline.asOf) / 3_600_000;
  if (ageH > cfg.regime.max_staleness_hours)
    return { favorable: true, reason: `baseline ${ageH.toFixed(0)}h stale (fail-open)` };
  const s = baseline.pairs[pair];
  if (!s) return { favorable: true, reason: "pair unmapped (fail-open)" };
  return s.favorable
    ? { favorable: true, reason: `emissions ${s.currentApy.toFixed(0)}% >= ${cfg.regime.min_ratio}x median ${s.medianApy.toFixed(0)}%` }
    : { favorable: false, reason: `STAND DOWN: emissions ${s.currentApy.toFixed(0)}% < ${cfg.regime.min_ratio}x median ${s.medianApy.toFixed(0)}% (faded regime)` };
}

/** Per-month deploy/stand-down classification over the full history — the
 *  honest validation that the gate rides spikes and stands down in low months.
 *  No lookahead: each month judged on the trailing median up to its start. */
export async function classifyHistory(
  pair: string,
  lookbackDays: number,
  minRatio: number,
): Promise<{ month: string; emisApy: number; trailingMedian: number; deploy: boolean }[]> {
  const uuid = UUID[pair];
  if (!uuid) return [];
  const data = await fetchSeries(uuid);
  const byMonth = new Map<string, { emis: number[]; idxEnd: number }>();
  data.forEach((r, i) => {
    const mo = r.timestamp.slice(0, 7);
    const b = byMonth.get(mo) ?? { emis: [], idxEnd: i };
    b.emis.push(r.apyReward ?? 0);
    b.idxEnd = i;
    byMonth.set(mo, b);
  });
  const out: { month: string; emisApy: number; trailingMedian: number; deploy: boolean }[] = [];
  let cursor = 0;
  for (const mo of [...byMonth.keys()].sort()) {
    const b = byMonth.get(mo)!;
    const trailing = data.slice(Math.max(0, cursor - lookbackDays), cursor).map((x) => x.apyReward ?? 0);
    const tmed = med(trailing);
    const emisApy = med(b.emis);
    const ratio = tmed > 0 ? emisApy / tmed : emisApy > 0 ? Infinity : 1;
    out.push({ month: mo, emisApy, trailingMedian: tmed, deploy: ratio >= minRatio });
    cursor = b.idxEnd + 1;
  }
  return out;
}

export { UUID as REGIME_UUIDS };
