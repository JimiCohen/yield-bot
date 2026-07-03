import type Database from "better-sqlite3";
import type { ChainClient } from "../chain/client.js";
import type { Config } from "../config/schema.js";
import { VENUES, readVenue, fetchAdvisoryRates, impliedAprPct, type Venue } from "./venues.js";

/**
 * PARK + GUARD paper allocator.
 *
 * The shadow position tracks the venue's ON-CHAIN accrual index — so paper
 * P&L is exactly what a real deposit would have earned (before ~cent-level
 * gas), with zero model assumptions. This is deliberately the opposite of the
 * failed CL strategy: nothing here is predicted; yield is measured after the
 * fact from the chain.
 *
 * Guard rules (checked every cycle, alert + optional auto-move):
 *  G1 BETTER_VENUE  — an alternative's advertised base APY exceeds the
 *     current venue's by >= switch_threshold_pp for >= switch_sustain_checks
 *     consecutive checks. (Advisory signal; sim showed this fires rarely.)
 *  G2 TVL_DRAIN     — current venue TVL down >= tvl_drain_fraction from its
 *     max over the trailing window. (Bank-run detector.)
 *  G3 ACCRUAL_STALL — on-chain index has not grown over >= stall_hours.
 *     (The vault stopped paying; advertised anything is irrelevant.)
 */

export function ensureAllocTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alloc_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      venue TEXT NOT NULL,
      entered_ts INTEGER NOT NULL,
      entry_index TEXT NOT NULL,      -- on-chain index at entry (bigint)
      notional_usd REAL NOT NULL,     -- paper capital deployed
      moves INTEGER NOT NULL DEFAULT 0,
      better_streak TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS alloc_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      venue TEXT NOT NULL,
      onchain_index TEXT NOT NULL,
      advertised_apy REAL,
      tvl_usd REAL,
      value_usd REAL NOT NULL,        -- notional grown by real index since entry
      implied_apr_pct REAL            -- from previous snapshot's index
    );
    CREATE TABLE IF NOT EXISTS alloc_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,             -- ENTER | SWITCH | ALERT
      detail TEXT NOT NULL
    );
  `);
}

interface AllocState {
  venue: string;
  enteredTs: number;
  entryIndex: bigint;
  notionalUsd: number;
  moves: number;
  betterStreak: Record<string, number>;
}

function getState(db: Database.Database): AllocState | null {
  const r = db.prepare("SELECT * FROM alloc_state WHERE id = 1").get() as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    venue: r.venue as string,
    enteredTs: r.entered_ts as number,
    entryIndex: BigInt(r.entry_index as string),
    notionalUsd: r.notional_usd as number,
    moves: r.moves as number,
    betterStreak: JSON.parse(r.better_streak as string) as Record<string, number>,
  };
}

function saveState(db: Database.Database, s: AllocState): void {
  db.prepare(
    `INSERT INTO alloc_state (id, venue, entered_ts, entry_index, notional_usd, moves, better_streak)
     VALUES (1,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET venue=excluded.venue, entered_ts=excluded.entered_ts,
       entry_index=excluded.entry_index, notional_usd=excluded.notional_usd,
       moves=excluded.moves, better_streak=excluded.better_streak`,
  ).run(s.venue, s.enteredTs, s.entryIndex.toString(), s.notionalUsd, s.moves, JSON.stringify(s.betterStreak));
}

function event(db: Database.Database, kind: string, detail: string): void {
  db.prepare("INSERT INTO alloc_events (ts, kind, detail) VALUES (?,?,?)").run(Date.now(), kind, detail);
}

export interface AllocCycleResult {
  venue: Venue;
  valueUsd: number;
  pnlUsd: number;
  impliedAprPct: number | null;
  advertisedApy: number | null;
  alerts: string[];
  switched: boolean;
}

/** One guard cycle: read chain, mark paper value, evaluate guards. */
export async function runAllocCycle(
  cfg: Config,
  client: ChainClient,
  db: Database.Database,
  log: (m: string) => void,
): Promise<AllocCycleResult> {
  ensureAllocTables(db);
  const A = cfg.allocator;
  const advisory = await fetchAdvisoryRates(VENUES);

  let state = getState(db);
  if (!state) {
    // First run: park in the venue with the best advertised BASE apy among
    // verified venues (one-time use of advisory for the seed decision).
    const readings = new Map<string, Awaited<ReturnType<typeof readVenue>>>();
    for (const v of VENUES) readings.set(v.key, await readVenue(client, v));
    const candidates = VENUES.filter((v) => readings.get(v.key)!.verified);
    if (candidates.length === 0) throw new Error("no venue passed on-chain verification");
    const best = candidates.reduce((a, b) =>
      (advisory[b.key]?.apyBase ?? 0) > (advisory[a.key]?.apyBase ?? 0) ? b : a,
    );
    state = {
      venue: best.key,
      enteredTs: Date.now(),
      entryIndex: readings.get(best.key)!.index,
      notionalUsd: A.capital_usd,
      moves: 1,
      betterStreak: {},
    };
    saveState(db, state);
    event(db, "ENTER", `${best.key} $${A.capital_usd} (advertised ${advisory[best.key]?.apyBase?.toFixed(2) ?? "?"}% base)`);
    log(`ENTER ${best.name}: $${A.capital_usd} paper (on-chain index ${state.entryIndex})`);
  }

  const venue = VENUES.find((v) => v.key === state!.venue)!;
  const reading = await readVenue(client, venue);
  const valueUsd = state.notionalUsd * (Number(reading.index) / Number(state.entryIndex));
  const adv = advisory[venue.key];

  // Implied APR vs previous snapshot (the honest, measured yield).
  const prev = db
    .prepare("SELECT onchain_index, ts FROM alloc_snapshots WHERE venue = ? ORDER BY ts DESC LIMIT 1")
    .get(venue.key) as { onchain_index: string; ts: number } | undefined;
  const implied = prev
    ? impliedAprPct({ index: BigInt(prev.onchain_index), ts: prev.ts }, { index: reading.index, ts: Date.now() })
    : null;

  db.prepare(
    "INSERT INTO alloc_snapshots (ts, venue, onchain_index, advertised_apy, tvl_usd, value_usd, implied_apr_pct) VALUES (?,?,?,?,?,?,?)",
  ).run(Date.now(), venue.key, reading.index.toString(), adv?.apyBase ?? null, adv?.tvlUsd ?? reading.totalAssetsUsd, valueUsd, implied);

  const alerts: string[] = [];
  let switched = false;

  // G3 ACCRUAL_STALL — compare against snapshot >= stall_hours old.
  const stallRef = db
    .prepare("SELECT onchain_index FROM alloc_snapshots WHERE venue = ? AND ts <= ? ORDER BY ts DESC LIMIT 1")
    .get(venue.key, Date.now() - A.stall_hours * 3_600_000) as { onchain_index: string } | undefined;
  if (stallRef && BigInt(stallRef.onchain_index) >= reading.index) {
    alerts.push(`ACCRUAL_STALL: ${venue.key} on-chain index flat for >= ${A.stall_hours}h — vault has stopped paying`);
  }

  // G2 TVL_DRAIN — vs trailing max.
  const peak = db
    .prepare("SELECT MAX(tvl_usd) m FROM alloc_snapshots WHERE venue = ? AND ts >= ?")
    .get(venue.key, Date.now() - A.tvl_window_days * 86_400_000) as { m: number | null };
  const tvlNow = adv?.tvlUsd ?? reading.totalAssetsUsd;
  if (peak.m && tvlNow !== null && tvlNow < peak.m * (1 - A.tvl_drain_fraction)) {
    alerts.push(`TVL_DRAIN: ${venue.key} TVL $${(tvlNow / 1e6).toFixed(1)}M is ${(100 * (1 - tvlNow / peak.m)).toFixed(0)}% below ${A.tvl_window_days}d peak — possible run`);
  }

  // G1 BETTER_VENUE — advertised spread sustained across checks.
  if (adv) {
    for (const alt of VENUES) {
      if (alt.key === venue.key) continue;
      const a = advisory[alt.key];
      if (!a) continue;
      const spread = a.apyBase - adv.apyBase;
      state.betterStreak[alt.key] = spread >= A.switch_threshold_pp ? (state.betterStreak[alt.key] ?? 0) + 1 : 0;
      if (state.betterStreak[alt.key]! >= A.switch_sustain_checks) {
        alerts.push(`BETTER_VENUE: ${alt.key} base ${a.apyBase.toFixed(2)}% > ${venue.key} ${adv.apyBase.toFixed(2)}% (+${spread.toFixed(2)}pp sustained ${state.betterStreak[alt.key]} checks)`);
        if (A.auto_switch) {
          const altReading = await readVenue(client, alt);
          if (altReading.verified) {
            state = {
              venue: alt.key,
              enteredTs: Date.now(),
              entryIndex: altReading.index,
              notionalUsd: valueUsd - A.move_cost_usd,
              moves: state.moves + 1,
              betterStreak: {},
            };
            event(db, "SWITCH", `${venue.key} -> ${alt.key} at $${valueUsd.toFixed(2)} (cost $${A.move_cost_usd})`);
            switched = true;
          }
        }
      }
    }
  }
  for (const a of alerts) event(db, "ALERT", a);
  saveState(db, state);

  return { venue, valueUsd, pnlUsd: valueUsd - A.capital_usd, impliedAprPct: implied, advertisedApy: adv?.apyBase ?? null, alerts, switched };
}
