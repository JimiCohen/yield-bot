import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PoolSnapshot } from "../types.js";

export interface PaperPositionRow {
  id: number;
  status: string;
  openedTs: number;
  openedBlock: number;
  pool: string;
  pair: string;
  tickSpacing: number;
  arm: string;
  widthMult: number;
  tickLower: number;
  tickUpper: number;
  liquidity: number;
  entryValueUsd: number;
  entryAmt0: number;
  entryAmt1: number;
  entryCostsUsd: number;
  predictedNetUsdH: number;
  positionUsd: number;
  feesUsd: number;
  pendingAero: number;
  lastCheckTs: number;
  lastFg0: bigint;
  lastFg1: bigint;
  lastTick: number;
  rebalances: number;
  extraCostsUsd: number;
}

function rowToPaperPosition(r: Record<string, unknown>): PaperPositionRow {
  return {
    id: r.id as number,
    status: r.status as string,
    openedTs: r.opened_ts as number,
    openedBlock: r.opened_block as number,
    pool: r.pool as string,
    pair: r.pair as string,
    tickSpacing: r.tick_spacing as number,
    arm: r.arm as string,
    widthMult: r.width_mult as number,
    tickLower: r.tick_lower as number,
    tickUpper: r.tick_upper as number,
    liquidity: r.liquidity as number,
    entryValueUsd: r.entry_value_usd as number,
    entryAmt0: r.entry_amt0 as number,
    entryAmt1: r.entry_amt1 as number,
    entryCostsUsd: r.entry_costs_usd as number,
    predictedNetUsdH: r.predicted_net_usd_h as number,
    positionUsd: r.position_usd as number,
    feesUsd: r.fees_usd as number,
    pendingAero: r.pending_aero as number,
    lastCheckTs: r.last_check_ts as number,
    lastFg0: BigInt((r.last_fg0 as string) ?? "0"),
    lastFg1: BigInt((r.last_fg1 as string) ?? "0"),
    lastTick: r.last_tick as number,
    rebalances: (r.rebalances as number) ?? 0,
    extraCostsUsd: (r.extra_costs_usd as number) ?? 0,
  };
}

/**
 * SQLite persistence. Design rule: the database is a CACHE of chain state
 * plus our own decision history — the chain is always canonical for "where
 * is the capital". Historical snapshots feed Phase 3 backtesting and the
 * predicted-vs-realized yield ledger.
 */
export class Store {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000"); // monitor + backtests share the file
    this.migrate();
    // Cache migration: rows fetched before period_finish existed must be
    // refetched — treating them as alive-by-default reintroduced the
    // killed-gauge phantom-emission bug.
    try {
      this.db.exec("ALTER TABLE history_samples ADD COLUMN period_finish INTEGER");
    } catch {
      /* column already exists */
    }
    this.db.exec("DELETE FROM history_samples WHERE miss = 0 AND period_finish IS NULL");
    // P5 migration: rebalance accounting on paper positions.
    for (const col of ["rebalances INTEGER NOT NULL DEFAULT 0", "extra_costs_usd REAL NOT NULL DEFAULT 0"]) {
      try {
        this.db.exec(`ALTER TABLE paper_positions ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        block_number INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pool_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL REFERENCES scans(id),
        pool TEXT NOT NULL,
        pair TEXT NOT NULL,
        tick_spacing INTEGER NOT NULL,
        fee_pips INTEGER,
        sqrt_price_x96 TEXT,
        tick INTEGER,
        liquidity TEXT,
        staked_liquidity TEXT,
        bal0 TEXT,
        bal1 TEXT,
        tvl_usdc REAL,
        gauge TEXT,
        gauge_alive INTEGER,
        reward_rate TEXT,
        period_finish INTEGER,
        llama_apy REAL,
        eligible INTEGER NOT NULL,
        fail_reasons TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_pool
        ON pool_snapshots(pool, scan_id);

      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        decision TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      -- Tick samples accumulated on every score run; feeds the local
      -- volatility estimator (source 3 in the vol ladder).
      CREATE TABLE IF NOT EXISTS price_samples (
        pool TEXT NOT NULL,
        ts INTEGER NOT NULL,
        block INTEGER NOT NULL,
        tick INTEGER NOT NULL,
        PRIMARY KEY (pool, block)
      );

      -- Historical chain-state samples for the backtester. miss=1 records
      -- blocks the RPC could not serve (or the pool did not exist) so we
      -- never refetch them.
      CREATE TABLE IF NOT EXISTS history_samples (
        pool TEXT NOT NULL,
        block INTEGER NOT NULL,
        ts INTEGER,
        tick INTEGER,
        sqrt_price_x96 TEXT,
        liquidity TEXT,
        staked_liquidity TEXT,
        fg0 TEXT,
        fg1 TEXT,
        reward_rate TEXT,
        period_finish INTEGER,
        bal0 TEXT,
        bal1 TEXT,
        miss INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pool, block)
      );

      CREATE TABLE IF NOT EXISTS backtest_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        params TEXT NOT NULL,
        summary TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backtest_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES backtest_runs(id),
        entry_ts INTEGER NOT NULL,
        pool TEXT NOT NULL,
        pair TEXT NOT NULL,
        arm TEXT NOT NULL,
        width_mult REAL NOT NULL,
        days_held REAL NOT NULL,
        predicted_net_usd_h REAL NOT NULL,
        realized_net_usd_h REAL NOT NULL,
        fees_usd REAL NOT NULL,
        emissions_usd REAL NOT NULL,
        value_change_usd REAL NOT NULL,
        costs_usd REAL NOT NULL,
        rebalances INTEGER NOT NULL
      );

      -- Paper positions: live-data shadow portfolio. Accruals are computed
      -- from real on-chain deltas at every monitor check; closing writes a
      -- realized entry to paper_entries (feeds model validation).
      CREATE TABLE IF NOT EXISTS paper_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'open',
        opened_ts INTEGER NOT NULL,
        opened_block INTEGER NOT NULL,
        pool TEXT NOT NULL,
        pair TEXT NOT NULL,
        tick_spacing INTEGER NOT NULL,
        arm TEXT NOT NULL,
        width_mult REAL NOT NULL,
        tick_lower INTEGER NOT NULL,
        tick_upper INTEGER NOT NULL,
        liquidity REAL NOT NULL,
        entry_value_usd REAL NOT NULL,
        entry_amt0 REAL NOT NULL,
        entry_amt1 REAL NOT NULL,
        entry_costs_usd REAL NOT NULL,
        predicted_net_usd_h REAL NOT NULL,
        position_usd REAL NOT NULL,
        fees_usd REAL NOT NULL DEFAULT 0,
        pending_aero REAL NOT NULL DEFAULT 0,
        last_check_ts INTEGER NOT NULL,
        last_fg0 TEXT,
        last_fg1 TEXT,
        last_tick INTEGER
      );

      -- Realized ledger for closed paper positions (same shape as
      -- backtest_entries; the union is what model validation consumes).
      CREATE TABLE IF NOT EXISTS paper_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL,
        entry_ts INTEGER NOT NULL,
        exit_ts INTEGER NOT NULL,
        pool TEXT NOT NULL,
        pair TEXT NOT NULL,
        arm TEXT NOT NULL,
        width_mult REAL NOT NULL,
        days_held REAL NOT NULL,
        predicted_net_usd_h REAL NOT NULL,
        realized_alpha_usd_h REAL NOT NULL,
        realized_net_usd REAL NOT NULL,
        fees_usd REAL NOT NULL,
        emissions_usd REAL NOT NULL,
        costs_usd REAL NOT NULL
      );

      -- Hysteresis state for Phase 5: when a position went out of range /
      -- beyond the deadband. Persisted so restarts don't reset the clock.
      CREATE TABLE IF NOT EXISTS range_state (
        position_key TEXT PRIMARY KEY,
        out_since INTEGER,
        beyond_deadband_since INTEGER,
        last_tick INTEGER,
        updated_ts INTEGER NOT NULL
      );

      -- Execution state machine (Phase 8): every capital movement is a
      -- persisted action with per-step status. The chain is canonical;
      -- these rows are the resume hints.
      CREATE TABLE IF NOT EXISTS exec_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        current_step INTEGER NOT NULL DEFAULT 0,
        context TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exec_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_id INTEGER NOT NULL REFERENCES exec_actions(id),
        step_index INTEGER NOT NULL,
        step_name TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        error TEXT,
        ts INTEGER NOT NULL
      );

      -- Live (on-chain) positions the bot manages; reconciliation diffs
      -- this against chain reality on every startup.
      CREATE TABLE IF NOT EXISTS live_positions (
        token_id TEXT PRIMARY KEY,
        pool TEXT NOT NULL,
        pair TEXT NOT NULL,
        arm TEXT NOT NULL,
        opened_ts INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
      );

      -- Rebalance history: feeds the per-position rate limit and the audit
      -- of realized rebalance costs.
      CREATE TABLE IF NOT EXISTS rebalance_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_key TEXT NOT NULL,
        ts INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        old_lower INTEGER NOT NULL,
        old_upper INTEGER NOT NULL,
        new_lower INTEGER NOT NULL,
        new_upper INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rebalance_events_key
        ON rebalance_events(position_key, ts);

      -- Score history: the predicted side of the predicted-vs-realized
      -- ledger the backtest (Phase 3) validates against.
      CREATE TABLE IF NOT EXISTS pool_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        block INTEGER NOT NULL,
        pool TEXT NOT NULL,
        pair TEXT NOT NULL,
        tick_spacing INTEGER NOT NULL,
        position_usd REAL NOT NULL,
        arm TEXT,
        width_mult REAL,
        gross_usd_h REAL,
        lvr_usd_h REAL,
        rebal_cost_usd_h REAL,
        entry_exit_usd REAL,
        net_usd_h REAL,
        ney_apr_pct REAL,
        vol_annual REAL,
        vol_source TEXT,
        flags TEXT NOT NULL,
        details TEXT NOT NULL
      );
    `);
  }

  beginScan(blockNumber: bigint): number {
    const r = this.db
      .prepare("INSERT INTO scans (ts, block_number) VALUES (?, ?)")
      .run(Date.now(), Number(blockNumber));
    return Number(r.lastInsertRowid);
  }

  insertSnapshot(scanId: number, s: PoolSnapshot) {
    this.db
      .prepare(
        `INSERT INTO pool_snapshots (
          scan_id, pool, pair, tick_spacing, fee_pips, sqrt_price_x96, tick,
          liquidity, staked_liquidity, bal0, bal1, tvl_usdc, gauge,
          gauge_alive, reward_rate, period_finish, llama_apy, eligible, fail_reasons
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        scanId,
        s.pool,
        s.pair,
        s.tickSpacing,
        s.feePips,
        s.sqrtPriceX96.toString(),
        s.tick,
        s.liquidity.toString(),
        s.stakedLiquidity?.toString() ?? null,
        s.bal0.toString(),
        s.bal1.toString(),
        s.tvlUsdc,
        s.gauge,
        s.gaugeAlive === null ? null : s.gaugeAlive ? 1 : 0,
        s.rewardRate?.toString() ?? null,
        s.periodFinish,
        s.llamaApy,
        s.eligible ? 1 : 0,
        JSON.stringify(s.failReasons),
      );
  }

  insertPriceSample(pool: string, ts: number, block: number, tick: number) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO price_samples (pool, ts, block, tick) VALUES (?,?,?,?)",
      )
      .run(pool, ts, block, tick);
  }

  getPriceSamples(pool: string, maxAgeSeconds: number): { ts: number; tick: number }[] {
    return this.db
      .prepare(
        "SELECT ts, tick FROM price_samples WHERE pool = ? AND ts >= ? ORDER BY ts ASC",
      )
      .all(pool, Date.now() - maxAgeSeconds * 1000) as { ts: number; tick: number }[];
  }

  insertScore(row: {
    ts: number;
    block: number;
    pool: string;
    pair: string;
    tickSpacing: number;
    positionUsd: number;
    arm: string | null;
    widthMult: number | null;
    grossUsdH: number | null;
    lvrUsdH: number | null;
    rebalCostUsdH: number | null;
    entryExitUsd: number | null;
    netUsdH: number | null;
    neyAprPct: number | null;
    volAnnual: number;
    volSource: string;
    flags: string[];
    details: unknown;
  }) {
    this.db
      .prepare(
        `INSERT INTO pool_scores (
          ts, block, pool, pair, tick_spacing, position_usd, arm, width_mult,
          gross_usd_h, lvr_usd_h, rebal_cost_usd_h, entry_exit_usd, net_usd_h,
          ney_apr_pct, vol_annual, vol_source, flags, details
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.ts,
        row.block,
        row.pool,
        row.pair,
        row.tickSpacing,
        row.positionUsd,
        row.arm,
        row.widthMult,
        row.grossUsdH,
        row.lvrUsdH,
        row.rebalCostUsdH,
        row.entryExitUsd,
        row.netUsdH,
        row.neyAprPct,
        row.volAnnual,
        row.volSource,
        JSON.stringify(row.flags),
        JSON.stringify(row.details),
      );
  }

  insertHistorySample(
    pool: string,
    block: number,
    s: {
      ts: number;
      tick: number;
      sqrtPriceX96: bigint;
      liquidity: bigint;
      stakedLiquidity: bigint;
      fg0: bigint;
      fg1: bigint;
      rewardRate: bigint;
      periodFinish: number;
      bal0: bigint;
      bal1: bigint;
    } | null,
  ) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO history_samples
         (pool, block, ts, tick, sqrt_price_x96, liquidity, staked_liquidity,
          fg0, fg1, reward_rate, period_finish, bal0, bal1, miss)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        pool,
        block,
        s?.ts ?? null,
        s?.tick ?? null,
        s?.sqrtPriceX96.toString() ?? null,
        s?.liquidity.toString() ?? null,
        s?.stakedLiquidity.toString() ?? null,
        s?.fg0.toString() ?? null,
        s?.fg1.toString() ?? null,
        s?.rewardRate.toString() ?? null,
        s?.periodFinish ?? (s === null ? null : 0),
        s?.bal0.toString() ?? null,
        s?.bal1.toString() ?? null,
        s === null ? 1 : 0,
      );
  }

  getHistoryBlocks(pools: string[]): { pool: string; block: number }[] {
    if (pools.length === 0) return [];
    const ph = pools.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT pool, block FROM history_samples WHERE pool IN (${ph})`)
      .all(...pools) as { pool: string; block: number }[];
  }

  getHistorySamples(pool: string): {
    block: number;
    sample: {
      ts: number;
      block: number;
      tick: number;
      sqrtPriceX96: bigint;
      liquidity: bigint;
      stakedLiquidity: bigint;
      fg0: bigint;
      fg1: bigint;
      rewardRate: bigint;
      periodFinish: number;
      bal0: bigint;
      bal1: bigint;
    } | null;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM history_samples WHERE pool = ? ORDER BY block ASC")
      .all(pool) as Record<string, unknown>[];
    return rows.map((r) => ({
      block: r.block as number,
      sample:
        (r.miss as number) === 1
          ? null
          : {
              ts: r.ts as number,
              block: r.block as number,
              tick: r.tick as number,
              sqrtPriceX96: BigInt(r.sqrt_price_x96 as string),
              liquidity: BigInt(r.liquidity as string),
              stakedLiquidity: BigInt(r.staked_liquidity as string),
              fg0: BigInt(r.fg0 as string),
              fg1: BigInt(r.fg1 as string),
              rewardRate: BigInt(r.reward_rate as string),
              periodFinish: (r.period_finish as number) ?? 0,
              bal0: BigInt(r.bal0 as string),
              bal1: BigInt(r.bal1 as string),
            },
    }));
  }

  insertBacktestRun(params: unknown, summary: unknown): number {
    const r = this.db
      .prepare("INSERT INTO backtest_runs (ts, params, summary) VALUES (?,?,?)")
      .run(Date.now(), JSON.stringify(params), JSON.stringify(summary));
    return Number(r.lastInsertRowid);
  }

  insertBacktestEntry(runId: number, e: {
    entryTs: number;
    pool: string;
    pair: string;
    arm: string;
    widthMult: number;
    daysHeld: number;
    predictedNetUsdH: number;
    realizedNetUsdH: number;
    feesUsd: number;
    emissionsUsd: number;
    valueChangeUsd: number;
    costsUsd: number;
    rebalances: number;
  }) {
    this.db
      .prepare(
        `INSERT INTO backtest_entries
         (run_id, entry_ts, pool, pair, arm, width_mult, days_held,
          predicted_net_usd_h, realized_net_usd_h, fees_usd, emissions_usd,
          value_change_usd, costs_usd, rebalances)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        runId,
        e.entryTs,
        e.pool,
        e.pair,
        e.arm,
        e.widthMult,
        e.daysHeld,
        e.predictedNetUsdH,
        e.realizedNetUsdH,
        e.feesUsd,
        e.emissionsUsd,
        e.valueChangeUsd,
        e.costsUsd,
        e.rebalances,
      );
  }

  // --- paper positions -----------------------------------------------------

  openPaperPosition(p: {
    openedTs: number;
    openedBlock: number;
    pool: string;
    pair: string;
    tickSpacing: number;
    arm: string;
    widthMult: number;
    tickLower: number;
    tickUpper: number;
    liquidity: number;
    entryValueUsd: number;
    entryAmt0: number;
    entryAmt1: number;
    entryCostsUsd: number;
    predictedNetUsdH: number;
    positionUsd: number;
    lastFg0: bigint;
    lastFg1: bigint;
    lastTick: number;
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO paper_positions (
          opened_ts, opened_block, pool, pair, tick_spacing, arm, width_mult,
          tick_lower, tick_upper, liquidity, entry_value_usd, entry_amt0,
          entry_amt1, entry_costs_usd, predicted_net_usd_h, position_usd,
          last_check_ts, last_fg0, last_fg1, last_tick
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.openedTs, p.openedBlock, p.pool, p.pair, p.tickSpacing, p.arm,
        p.widthMult, p.tickLower, p.tickUpper, p.liquidity, p.entryValueUsd,
        p.entryAmt0, p.entryAmt1, p.entryCostsUsd, p.predictedNetUsdH,
        p.positionUsd, p.openedTs, p.lastFg0.toString(), p.lastFg1.toString(),
        p.lastTick,
      );
    return Number(r.lastInsertRowid);
  }

  getOpenPaperPositions(): PaperPositionRow[] {
    return (
      this.db
        .prepare("SELECT * FROM paper_positions WHERE status = 'open' ORDER BY id")
        .all() as Record<string, unknown>[]
    ).map(rowToPaperPosition);
  }

  getPaperPosition(id: number): PaperPositionRow | null {
    const r = this.db
      .prepare("SELECT * FROM paper_positions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return r ? rowToPaperPosition(r) : null;
  }

  updatePaperAccrual(
    id: number,
    p: { feesUsd: number; pendingAero: number; lastCheckTs: number; lastFg0: bigint; lastFg1: bigint; lastTick: number },
  ) {
    this.db
      .prepare(
        `UPDATE paper_positions SET fees_usd = ?, pending_aero = ?,
         last_check_ts = ?, last_fg0 = ?, last_fg1 = ?, last_tick = ?
         WHERE id = ?`,
      )
      .run(p.feesUsd, p.pendingAero, p.lastCheckTs, p.lastFg0.toString(), p.lastFg1.toString(), p.lastTick, id);
  }

  closePaperPosition(
    id: number,
    e: {
      exitTs: number;
      daysHeld: number;
      realizedAlphaUsdH: number;
      realizedNetUsd: number;
      feesUsd: number;
      emissionsUsd: number;
      costsUsd: number;
    },
  ) {
    const p = this.getPaperPosition(id);
    if (!p) throw new Error(`paper position ${id} not found`);
    this.db.prepare("UPDATE paper_positions SET status = 'closed' WHERE id = ?").run(id);
    this.db
      .prepare(
        `INSERT INTO paper_entries (
          position_id, entry_ts, exit_ts, pool, pair, arm, width_mult,
          days_held, predicted_net_usd_h, realized_alpha_usd_h,
          realized_net_usd, fees_usd, emissions_usd, costs_usd
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, p.openedTs, e.exitTs, p.pool, p.pair, p.arm, p.widthMult,
        e.daysHeld, p.predictedNetUsdH, e.realizedAlphaUsdH, e.realizedNetUsd,
        e.feesUsd, e.emissionsUsd, e.costsUsd,
      );
  }

  applyPaperRebalance(
    id: number,
    p: {
      tickLower: number;
      tickUpper: number;
      widthMult: number;
      liquidity: number;
      extraCostsUsd: number;
      rebalances: number;
      lastTick: number;
    },
  ) {
    this.db
      .prepare(
        `UPDATE paper_positions SET tick_lower = ?, tick_upper = ?, width_mult = ?,
         liquidity = ?, extra_costs_usd = ?, rebalances = ?, last_tick = ?
         WHERE id = ?`,
      )
      .run(
        p.tickLower, p.tickUpper, p.widthMult, p.liquidity,
        p.extraCostsUsd, p.rebalances, p.lastTick, id,
      );
  }

  recordRebalanceEvent(e: {
    positionKey: string;
    costUsd: number;
    oldLower: number;
    oldUpper: number;
    newLower: number;
    newUpper: number;
  }) {
    this.db
      .prepare(
        `INSERT INTO rebalance_events
         (position_key, ts, cost_usd, old_lower, old_upper, new_lower, new_upper)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(e.positionKey, Date.now(), e.costUsd, e.oldLower, e.oldUpper, e.newLower, e.newUpper);
  }

  countRecentRebalances(positionKey: string, windowMs: number): number {
    const r = this.db
      .prepare("SELECT COUNT(*) n FROM rebalance_events WHERE position_key = ? AND ts >= ?")
      .get(positionKey, Date.now() - windowMs) as { n: number };
    return r.n;
  }

  // --- execution machine -----------------------------------------------------

  insertAction(kind: string, context: unknown): number {
    const r = this.db
      .prepare(
        "INSERT INTO exec_actions (kind, status, context, created_ts, updated_ts) VALUES (?,?,?,?,?)",
      )
      .run(kind, "pending", JSON.stringify(context), Date.now(), Date.now());
    return Number(r.lastInsertRowid);
  }

  getAction(id: number): {
    id: number;
    kind: string;
    status: "pending" | "running" | "done" | "halted";
    currentStep: number;
    context: unknown;
  } | null {
    const r = this.db.prepare("SELECT * FROM exec_actions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as number,
      kind: r.kind as string,
      status: r.status as "pending" | "running" | "done" | "halted",
      currentStep: r.current_step as number,
      context: JSON.parse(r.context as string),
    };
  }

  getActionsByStatus(status: string) {
    return (
      this.db
        .prepare("SELECT * FROM exec_actions WHERE status = ? ORDER BY id")
        .all(status) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      kind: r.kind as string,
      status: r.status as "pending" | "running" | "done" | "halted",
      currentStep: r.current_step as number,
      context: JSON.parse(r.context as string),
    }));
  }

  setActionStatus(id: number, status: string, currentStep: number, context?: unknown) {
    if (context !== undefined) {
      this.db
        .prepare(
          "UPDATE exec_actions SET status = ?, current_step = ?, context = ?, updated_ts = ? WHERE id = ?",
        )
        .run(status, currentStep, JSON.stringify(context), Date.now(), id);
    } else {
      this.db
        .prepare("UPDATE exec_actions SET status = ?, current_step = ?, updated_ts = ? WHERE id = ?")
        .run(status, currentStep, Date.now(), id);
    }
  }

  recordStep(actionId: number, index: number, name: string, status: string, txHash: string | null, error: string | null) {
    this.db
      .prepare(
        "INSERT INTO exec_steps (action_id, step_index, step_name, status, tx_hash, error, ts) VALUES (?,?,?,?,?,?,?)",
      )
      .run(actionId, index, name, status, txHash, error, Date.now());
  }

  upsertLivePosition(tokenId: string, pool: string, pair: string, arm: string) {
    this.db
      .prepare(
        `INSERT INTO live_positions (token_id, pool, pair, arm, opened_ts, status)
         VALUES (?,?,?,?,?,'open')
         ON CONFLICT(token_id) DO UPDATE SET status = 'open'`,
      )
      .run(tokenId, pool, pair, arm, Date.now());
  }

  closeLivePosition(tokenId: string) {
    this.db.prepare("UPDATE live_positions SET status = 'closed' WHERE token_id = ?").run(tokenId);
  }

  getOpenLivePositions(): { tokenId: string; pool: string; pair: string; arm: string; openedTs: number }[] {
    return (
      this.db
        .prepare("SELECT * FROM live_positions WHERE status = 'open'")
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      tokenId: r.token_id as string,
      pool: r.pool as string,
      pair: r.pair as string,
      arm: r.arm as string,
      openedTs: r.opened_ts as number,
    }));
  }

  /** Validation stats from the paper ledger — the phase gate reads this.
   *
   * Hold-time weighted: realized alpha is annualized to the horizon, so a
   * 20-minute hold gets its noise multiplied ~500x while an 8-hour hold gets
   * ~21x. Equal-weighting let the shortest, noisiest holds dominate the
   * accuracy score. Each entry's weight is its days_held (capped at the
   * 7-day horizon), and per-entry ratios are clamped to ±5 so one
   * annualization blow-up cannot drag the mean outside any band. */
  getValidationStats(): { entries: number; signAgreement: number; meanRatio: number } {
    const rows = this.db
      .prepare(
        "SELECT predicted_net_usd_h p, realized_alpha_usd_h r, days_held d FROM paper_entries",
      )
      .all() as { p: number; r: number; d: number }[];
    if (rows.length === 0) return { entries: 0, signAgreement: 0, meanRatio: NaN };
    const w = (x: { d: number }) => Math.min(Math.max(x.d, 0.01), 7);
    const wSum = rows.reduce((a, x) => a + w(x), 0);
    const agree =
      rows.reduce((a, x) => a + (Math.sign(x.r) === Math.sign(x.p) ? w(x) : 0), 0) / wSum;
    const rated = rows.filter((x) => Math.abs(x.p) > 0.5);
    const rwSum = rated.reduce((a, x) => a + w(x), 0);
    const meanRatio = rated.length
      ? rated.reduce((a, x) => a + Math.max(-5, Math.min(5, x.r / x.p)) * w(x), 0) / rwSum
      : NaN;
    return { entries: rows.length, signAgreement: agree, meanRatio };
  }

  /** Peak TVL for a pool over a trailing window, from scan snapshots. */
  getPeakTvl(pool: string, windowMs: number): number | null {
    const r = this.db
      .prepare(
        `SELECT MAX(ps.tvl_usdc) peak FROM pool_snapshots ps
         JOIN scans s ON s.id = ps.scan_id
         WHERE lower(ps.pool) = lower(?) AND s.ts >= ?`,
      )
      .get(pool, Date.now() - windowMs) as { peak: number | null };
    return r.peak;
  }

  // --- range / hysteresis state ---------------------------------------------

  getRangeState(key: string): { outSince: number | null; beyondDeadbandSince: number | null } {
    const r = this.db
      .prepare("SELECT out_since, beyond_deadband_since FROM range_state WHERE position_key = ?")
      .get(key) as { out_since: number | null; beyond_deadband_since: number | null } | undefined;
    return { outSince: r?.out_since ?? null, beyondDeadbandSince: r?.beyond_deadband_since ?? null };
  }

  setRangeState(key: string, outSince: number | null, beyondDeadbandSince: number | null, tick: number) {
    this.db
      .prepare(
        `INSERT INTO range_state (position_key, out_since, beyond_deadband_since, last_tick, updated_ts)
         VALUES (?,?,?,?,?)
         ON CONFLICT(position_key) DO UPDATE SET
           out_since = excluded.out_since,
           beyond_deadband_since = excluded.beyond_deadband_since,
           last_tick = excluded.last_tick,
           updated_ts = excluded.updated_ts`,
      )
      .run(key, outSince, beyondDeadbandSince, tick, Date.now());
  }

  recordDecision(kind: string, subject: string, decision: string, payload: unknown) {
    this.db
      .prepare(
        "INSERT INTO decisions (ts, kind, subject, decision, payload) VALUES (?,?,?,?,?)",
      )
      .run(Date.now(), kind, subject, decision, JSON.stringify(payload));
  }

  close() {
    this.db.close();
  }
}
