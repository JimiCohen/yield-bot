import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../config/load.js";

/**
 * Dashboard server — visualization + control plane.
 *
 * Design rules:
 *  - LOCALHOST ONLY by default (config server.host). This process can start
 *    LIVE trading; exposing it unauthenticated would hand the bot's controls
 *    to the network.
 *  - The server never reimplements bot logic. Controls SPAWN the same CLI
 *    commands a human would run, so every safety gate (paper default,
 *    two-key live safety, validation gate, router verification) is enforced
 *    by the child process itself — the dashboard cannot bypass what the CLI
 *    refuses.
 *  - Reads go straight to SQLite (read-only handle). The DB is the bot's
 *    own state; the dashboard adds no new state beyond child lifecycles.
 */

const CONFIG_PATH = process.argv.includes("--config")
  ? process.argv[process.argv.indexOf("--config") + 1]!
  : "config.yaml";
const cfg = loadConfig(CONFIG_PATH);
const db = new Database(cfg.db.path, { readonly: true, fileMustExist: false });
const WEB_DIR = join(process.cwd(), "web");

/**
 * No in-app authentication BY DESIGN: this server binds localhost only and
 * refuses anything else. Remote/cloud access is provided by infrastructure
 * in front of it (Tailscale, or a reverse proxy with auth — see DEPLOY.md),
 * never by exposing this process directly.
 */
// Container escape hatch: inside Docker, the reverse proxy (which carries
// the authentication) reaches this process over the compose-private network,
// so it must bind beyond loopback THERE AND ONLY THERE. The env value is a
// sentence on purpose — it should never be set by accident.
const unsafeBind = process.env.DASHBOARD_UNSAFE_BIND === "behind-my-own-proxy";
const host = unsafeBind ? "0.0.0.0" : cfg.server.host;
const isLocal = host === "127.0.0.1" || host === "localhost";
if (!isLocal && !unsafeBind) {
  console.error(
    `REFUSING to bind ${host}: this server is localhost-only by design. ` +
      `For cloud/remote access put authenticated infrastructure in front (see DEPLOY.md).`,
  );
  process.exit(1);
}
if (unsafeBind) {
  console.warn(
    "⚠ DASHBOARD_UNSAFE_BIND active: binding 0.0.0.0. This is ONLY safe on a " +
      "private container network behind your authenticated proxy. Never publish this port.",
  );
}

// ---------------------------------------------------------------------------
// Task management: one child per kind, log ring buffers, SSE fan-out.
// ---------------------------------------------------------------------------

type TaskKind = "paper" | "backtest" | "live";

interface Task {
  proc: ChildProcess;
  startedAt: number;
  log: string[];
  listeners: Set<ServerResponse>;
  exitCode: number | null;
}

const tasks = new Map<TaskKind, Task>();
const LOG_LIMIT = 800;

function taskArgs(kind: TaskKind, body: Record<string, unknown>): string[] {
  // children inherit THIS dashboard's venue config (multi-venue support)
  const venue = ["--config", CONFIG_PATH];
  switch (kind) {
    case "paper":
      return ["src/cli/index.ts", "monitor", "--watch", ...venue];
    case "backtest": {
      const days = Number(body.days) > 0 ? Number(body.days) : cfg.backtest.days;
      const args = ["src/cli/index.ts", "backtest", "--days", String(days)];
      if (Number(body.stepHours) > 0) args.push("--step-hours", String(body.stepHours));
      return [...args, ...venue];
    }
    case "live":
      return ["src/cli/index.ts", "live", "--live", ...venue];
  }
}

function startTask(kind: TaskKind, body: Record<string, unknown>): { ok: boolean; error?: string } {
  const existing = tasks.get(kind);
  if (existing && existing.exitCode === null) {
    return { ok: false, error: `${kind} is already running` };
  }
  if (kind === "live" && body.confirm !== "LIVE") {
    return { ok: false, error: 'live start requires confirm:"LIVE"' };
  }
  const proc = spawn("npx", ["tsx", ...taskArgs(kind, body)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const task: Task = { proc, startedAt: Date.now(), log: [], listeners: new Set(), exitCode: null };
  const push = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      task.log.push(line);
      if (task.log.length > LOG_LIMIT) task.log.shift();
      for (const res of task.listeners) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
    }
  };
  proc.stdout!.on("data", push);
  proc.stderr!.on("data", push);
  proc.on("exit", (code) => {
    task.exitCode = code ?? -1;
    const msg = `[task ${kind} exited with code ${code}]`;
    task.log.push(msg);
    for (const res of task.listeners) {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    }
  });
  tasks.set(kind, task);
  return { ok: true };
}

function stopTask(kind: TaskKind): { ok: boolean; error?: string } {
  const task = tasks.get(kind);
  if (!task || task.exitCode !== null) return { ok: false, error: `${kind} is not running` };
  task.proc.kill("SIGTERM");
  return { ok: true };
}

function taskStatus(kind: TaskKind) {
  const t = tasks.get(kind);
  if (!t) return { state: "stopped", startedAt: null, exitCode: null };
  return {
    state: t.exitCode === null ? "running" : "exited",
    startedAt: t.startedAt,
    exitCode: t.exitCode,
  };
}

// ---------------------------------------------------------------------------
// Data queries (read-only).
// ---------------------------------------------------------------------------

function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return []; // table may not exist before first run of a phase
  }
}

function validationStats() {
  const rows = q<{ p: number; r: number }>(
    "SELECT predicted_net_usd_h p, realized_alpha_usd_h r FROM paper_entries",
  );
  const e = cfg.execution;
  if (rows.length === 0) {
    return { entries: 0, signAgreement: null, meanRatio: null, thresholds: e, passed: false };
  }
  const agree = rows.filter((x) => Math.sign(x.r) === Math.sign(x.p)).length / rows.length;
  const ratios = rows.filter((x) => Math.abs(x.p) > 0.5).map((x) => x.r / x.p);
  const meanRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
  const passed =
    rows.length >= e.validation_min_entries &&
    agree >= e.validation_min_sign_agreement &&
    meanRatio !== null &&
    meanRatio >= e.validation_ratio_min &&
    meanRatio <= e.validation_ratio_max;
  return { entries: rows.length, signAgreement: agree, meanRatio, thresholds: e, passed };
}

const api: Record<string, (url: URL) => unknown> = {
  "/api/status": () => ({
    now: Date.now(),
    mode: cfg.mode,
    venue: cfg.chain.id === 10 ? "Velodrome · Optimism" : "Aerodrome · Base",
    capitalUsdc: cfg.capital_usdc,
    horizonDays: cfg.scoring.horizon_days,
    minNetYieldApr: cfg.scoring.min_net_yield_apr,
    keyPresent: Boolean(process.env[cfg.wallet.private_key_env]),
    tasks: { paper: taskStatus("paper"), backtest: taskStatus("backtest"), live: taskStatus("live") },
    validation: validationStats(),
    lastScan: q("SELECT id, ts, block_number FROM scans ORDER BY id DESC LIMIT 1")[0] ?? null,
    earnings: (() => {
      // REAL paper P&L: realized from closed trades + unrealized marks on
      // open positions (from the monitor's latest on-chain check).
      const realized = q<{ s: number }>(
        "SELECT COALESCE(SUM(realized_net_usd),0) s FROM paper_entries",
      )[0]!.s;
      const open = q<{ id: number; position_usd: number }>(
        "SELECT id, position_usd FROM paper_positions WHERE status='open'",
      );
      const checks = q<{ id: number; v: number; f: number; a: number }>(
        `SELECT json_extract(payload,'$.paperId') id,
                json_extract(payload,'$.valueUsd') v,
                json_extract(payload,'$.feesUsd') f,
                json_extract(payload,'$.pendingAeroUsd') a,
                MAX(ts) mts
         FROM decisions WHERE kind='monitor' GROUP BY json_extract(payload,'$.paperId')`,
      );
      let unrealized = 0;
      for (const o of open) {
        const c = checks.find((x) => Number(x.id) === o.id);
        if (c && c.v != null) unrealized += c.v + (c.f ?? 0) + (c.a ?? 0) - o.position_usd;
      }
      return { realizedUsd: realized, unrealizedUsd: unrealized, closedTrades: q<{n:number}>("SELECT COUNT(*) n FROM paper_entries")[0]!.n };
    })(),
  }),

  // The money map: every strategy the platform detected, ranked, with the
  // model's ACCURATE net APR (after losses+costs — never the headline) and
  // a deployability verdict the UI can act on in one click.
  "/api/opportunities": () => {
    const latest = q<{ b: number }>("SELECT MAX(block) b FROM pool_scores")[0];
    if (!latest?.b) return { opportunities: [], block: null };
    const held = new Set(
      q<{ pool: string }>("SELECT pool FROM paper_positions WHERE status='open'").map((r) =>
        r.pool.toLowerCase(),
      ),
    );
    const deployedUsd = q<{ s: number }>(
      "SELECT COALESCE(SUM(position_usd),0) s FROM paper_positions WHERE status='open'",
    )[0]!.s;
    const rows = q(
      `SELECT pool, pair, tick_spacing, arm, width_mult, position_usd, net_usd_h,
              ney_apr_pct, gross_usd_h, lvr_usd_h, vol_annual, vol_source, flags
       FROM pool_scores WHERE block = ? ORDER BY net_usd_h DESC`,
      latest.b,
    ).map((r) => {
      const flags: string[] = JSON.parse((r.flags as string) || "[]");
      const viable =
        (r.net_usd_h as number) > 0 &&
        (r.ney_apr_pct as number) >= cfg.scoring.min_net_yield_apr &&
        !flags.includes("ADVISORY_APY_UNRECONCILED");
      return {
        ...r,
        flags,
        viable,
        held: held.has((r.pool as string).toLowerCase()),
        fitsCapital: deployedUsd + (r.position_usd as number) <= cfg.capital_usdc,
      };
    });
    return {
      block: latest.b,
      capitalUsd: cfg.capital_usdc,
      deployedUsd,
      maxPositions: cfg.position.max_positions,
      openCount: held.size,
      opportunities: rows,
    };
  },

  "/api/scores": () => {
    const latest = q<{ b: number }>("SELECT MAX(block) b FROM pool_scores")[0];
    if (!latest?.b) return { block: null, scores: [] };
    return {
      block: latest.b,
      scores: q(
        `SELECT pair, tick_spacing, arm, width_mult, gross_usd_h, lvr_usd_h,
                rebal_cost_usd_h, entry_exit_usd, net_usd_h, ney_apr_pct,
                vol_annual, vol_source, flags, ts
         FROM pool_scores WHERE block = ? ORDER BY net_usd_h DESC`,
        latest.b,
      ),
    };
  },

  "/api/score-history": () => ({
    points: q(
      `SELECT ts, pair || ' ts' || tick_spacing AS key, ney_apr_pct
       FROM pool_scores WHERE ts >= ? ORDER BY ts ASC`,
      Date.now() - 7 * 86_400_000,
    ),
  }),

  "/api/positions": () => ({
    open: q("SELECT * FROM paper_positions WHERE status = 'open' ORDER BY id"),
    // last known check per open position, from the monitor audit trail
    checks: q(
      `SELECT subject pool, payload, MAX(ts) ts FROM decisions
       WHERE kind = 'monitor' GROUP BY json_extract(payload, '$.paperId')`,
    ).map((r) => ({ ...r, payload: JSON.parse(r.payload as string) })),
    valueHistory: q(
      `SELECT ts, json_extract(payload,'$.paperId') id,
              json_extract(payload,'$.valueUsd') value,
              json_extract(payload,'$.feesUsd') fees,
              json_extract(payload,'$.pendingAeroUsd') aero
       FROM decisions WHERE kind = 'monitor' AND ts >= ? ORDER BY ts ASC`,
      Date.now() - 14 * 86_400_000,
    ),
  }),

  "/api/ledger": () => ({
    entries: q("SELECT * FROM paper_entries ORDER BY exit_ts DESC LIMIT 100"),
    validation: validationStats(),
  }),

  "/api/backtests": () => {
    const runs = q("SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 10").map((r) => ({
      ...(r as Record<string, unknown>),
      id: r.id as number,
      params: JSON.parse(r.params as string),
      summary: JSON.parse(r.summary as string),
    }));
    const latest = runs[0];
    return {
      runs,
      latestEntries: latest
        ? q("SELECT * FROM backtest_entries WHERE run_id = ? ORDER BY entry_ts", latest.id)
        : [],
    };
  },

  "/api/decisions": (url) => {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 80), 300);
    return {
      decisions: q(
        "SELECT ts, kind, subject, decision, payload FROM decisions ORDER BY ts DESC LIMIT ?",
        limit,
      ).map((r) => ({ ...r, payload: JSON.parse(r.payload as string) })),
    };
  },

  "/api/live-positions": () => ({
    open: q("SELECT * FROM live_positions WHERE status = 'open'"),
    actions: q("SELECT * FROM exec_actions ORDER BY id DESC LIMIT 20").map((r) => ({
      ...r,
      context: JSON.parse(r.context as string),
    })),
  }),
};

// ---------------------------------------------------------------------------
// HTTP plumbing.
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  // --- API: reads ----------------------------------------------------------
  if (req.method === "GET" && api[path]) {
    return json(res, 200, api[path]!(url));
  }

  // --- API: log streaming (SSE) -------------------------------------------
  const logMatch = path.match(/^\/api\/logs\/(paper|backtest|live)$/);
  if (req.method === "GET" && logMatch) {
    const task = tasks.get(logMatch[1] as TaskKind);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (task) {
      for (const line of task.log.slice(-200)) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
      task.listeners.add(res);
      req.on("close", () => task.listeners.delete(res));
    } else {
      res.write(`data: ${JSON.stringify("[not started]")}\n\n`);
    }
    return;
  }

  // --- API: controls ---------------------------------------------------------
  const ctlMatch = path.match(/^\/api\/control\/(paper|backtest|live)\/(start|stop)$/);
  if (req.method === "POST" && ctlMatch) {
    const [, kind, verb] = ctlMatch;
    const body = await readBody(req);
    const result =
      verb === "start" ? startTask(kind as TaskKind, body) : stopTask(kind as TaskKind);
    return json(res, result.ok ? 200 : 409, result);
  }
  if (req.method === "POST" && path === "/api/control/deploy") {
    const body = await readBody(req);
    if (typeof body.pool !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.pool)) {
      return json(res, 400, { ok: false, error: "pool address required" });
    }
    const proc = spawn(
      "npx",
      ["tsx", "src/cli/index.ts", "paper-open", "--pool", body.pool, "--config", CONFIG_PATH],
      { cwd: process.cwd(), env: process.env },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("exit", (code) =>
      json(res, code === 0 ? 200 : 500, { ok: code === 0, output: out.trim().slice(-400) }),
    );
    return;
  }
  if (req.method === "POST" && path === "/api/control/paper/close") {
    const body = await readBody(req);
    const args = ["tsx", "src/cli/index.ts", "paper-close"];
    if (body.id) args.push(String(body.id));
    args.push("--config", CONFIG_PATH);
    const proc = spawn("npx", args, { cwd: process.cwd(), env: process.env });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("exit", (code) => json(res, code === 0 ? 200 : 500, { ok: code === 0, output: out.trim() }));
    return;
  }

  // --- static frontend -------------------------------------------------------
  const file = path === "/" ? "index.html" : path.slice(1);
  const full = join(WEB_DIR, file);
  if (full.startsWith(WEB_DIR) && existsSync(full)) {
    res.writeHead(200, {
      "content-type": MIME[extname(full)] ?? "application/octet-stream",
      // never let a browser pin a stale dashboard build
      "cache-control": "no-cache, no-store, must-revalidate",
    });
    return res.end(readFileSync(full));
  }
  json(res, 404, { error: "not found" });
});

server.listen(cfg.server.port, host, () => {
  console.log(`dashboard: http://${host}:${cfg.server.port}${isLocal ? " (localhost only)" : " (container mode — proxy provides auth)"}`);
  // Headless cloud deployments set AUTO_START_PAPER=1 so the bot trades
  // 24/7 (building the validation track record) without anyone clicking
  // "Start". This NEVER auto-starts LIVE — only the paper monitor loop;
  // live still requires mode:live + the validation gate + the --live flag.
  if (process.env.AUTO_START_PAPER === "1") {
    const r = startTask("paper", {});
    console.log(`auto-start paper trading: ${r.ok ? "running" : "failed — " + r.error}`);
  }
});
