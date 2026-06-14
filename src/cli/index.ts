import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../config/load.js";
import { makeClient } from "../chain/client.js";
import { Store } from "../data/store.js";
import { AuditLog } from "../audit/log.js";
import { fetchLlamaAdvisory } from "../data/llama.js";
import { scanPools } from "../data/scanner.js";
import { scorePools, positionSizeUsd } from "../scoring/netYield.js";
import { discoverAeroPricing } from "../scoring/emissions.js";
import { fetchHistory } from "../sim/history.js";
import { runBacktest } from "../sim/backtest.js";
import { fetchOnchainPositions, resolveOwner } from "../monitor/positions.js";
import {
  checkPaperPosition,
  closePaperPosition,
  openPaperPosition,
} from "../monitor/paper.js";
import { evaluateRebalance, executePaperRebalance } from "../strategy/rebalance.js";
import { makeSigner, verifySwapRouter } from "../exec/signer.js";
import { ExecutionMachine } from "../exec/machine.js";
import { reconcile } from "../exec/reconcile.js";
import { runLiveCycle, assertValidationPassed } from "../exec/live.js";
import { enterSteps, exitSteps, type EnterCtx, type ExitCtx } from "../exec/actions.js";
import { buildRoutes } from "../exec/live.js";
import { Alerts } from "../alerts/telegram.js";
import { evaluateSwitch } from "../strategy/switch.js";
import { checkRiskTriggers } from "../strategy/risk.js";
import { viableScores } from "../scoring/netYield.js";
import type { PoolScore } from "../scoring/netYield.js";
import { loadRegimeBaseline, refreshRegimeBaseline, isRegimeFavorable, buildHistoricalRegimeOracle } from "../scoring/regime.js";
import type { PoolPricing } from "../scoring/clmath.js";

function fmtUsd(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

async function cmdScan(configPath: string) {
  const cfg = loadConfig(configPath);
  const client = makeClient(cfg);
  const store = new Store(cfg.db.path);
  const audit = new AuditLog(store, cfg.audit.jsonl_path);

  console.log(`mode=${cfg.mode} capital=${fmtUsd(cfg.capital_usdc)} chain=Base`);
  console.log("Fetching DeFiLlama advisory data (soft dependency)...");
  const llama = await fetchLlamaAdvisory();
  if (!llama) console.log("  Llama unavailable — proceeding on-chain only.");

  console.log("Scanning Aerodrome Slipstream pools (on-chain canonical)...");
  const { blockNumber, snapshots, pricesUsd } = await scanPools(cfg, client, llama);
  const scanId = store.beginScan(blockNumber);

  console.log(`\nBlock ${blockNumber}. Reference prices (from deepest USDC pools):`);
  for (const [sym, p] of Object.entries(pricesUsd)) {
    console.log(`  ${sym}: ${p.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`);
  }

  // Persist + audit every snapshot, including rejections (the audit trail of
  // why a pool was NOT considered is as important as why one was).
  for (const s of snapshots) {
    store.insertSnapshot(scanId, s);
    audit.record("scan", s.pool, s.eligible ? "ELIGIBLE" : "REJECTED", {
      pair: s.pair,
      tickSpacing: s.tickSpacing,
      tvlUsdc: Math.round(s.tvlUsdc),
      gauge: s.gauge,
      gaugeAlive: s.gaugeAlive,
      rewardRateAeroPerDay:
        s.rewardRate !== null ? Number(s.rewardRate / 10n ** 12n) / 1e6 * 86400 : null,
      llamaApy: s.llamaApy,
      reasons: s.failReasons,
      block: Number(blockNumber),
    });
  }

  // ---- Report -------------------------------------------------------------
  const header = [
    "PAIR".padEnd(11),
    "TICKSP".padEnd(7),
    "FEE%".padEnd(7),
    "TVL".padEnd(13),
    "STAKED%".padEnd(8),
    "AERO/day".padEnd(10),
    "LLAMA APY".padEnd(10),
    "STATUS",
  ].join(" ");
  console.log("\n" + header);
  console.log("-".repeat(header.length + 10));

  const sorted = [...snapshots].sort((a, b) => b.tvlUsdc - a.tvlUsdc);
  for (const s of sorted) {
    const feePct = s.feePips !== null ? (s.feePips / 1e4).toFixed(3) : "?";
    const stakedPct =
      s.stakedLiquidity !== null && s.liquidity > 0n
        ? ((Number(s.stakedLiquidity) / Number(s.liquidity)) * 100).toFixed(0) + "%"
        : "-";
    const aeroDay =
      s.rewardRate !== null
        ? (Number(s.rewardRate / 10n ** 12n) / 1e6 * 86400).toFixed(0)
        : "-";
    const llamaCol = s.llamaApy !== null ? s.llamaApy.toFixed(1) + "%" : "-";
    const status = s.eligible ? "ELIGIBLE" : `REJECTED: ${s.failReasons.join(", ")}`;
    console.log(
      [
        s.pair.padEnd(11),
        String(s.tickSpacing).padEnd(7),
        feePct.padEnd(7),
        fmtUsd(s.tvlUsdc).padEnd(13),
        stakedPct.padEnd(8),
        aeroDay.padEnd(10),
        llamaCol.padEnd(10),
        status,
      ].join(" "),
    );
  }

  const eligible = snapshots.filter((s) => s.eligible);
  console.log(
    `\n${snapshots.length} pools found, ${eligible.length} eligible after hard filters.`,
  );
  console.log(`Snapshots persisted (scan #${scanId}); decisions appended to ${cfg.audit.jsonl_path}`);
  store.close();
}

async function cmdScore(configPath: string) {
  const cfg = loadConfig(configPath);
  const client = makeClient(cfg);
  const store = new Store(cfg.db.path);
  const audit = new AuditLog(store, cfg.audit.jsonl_path);

  console.log(`mode=${cfg.mode} capital=${fmtUsd(cfg.capital_usdc)} horizon=${cfg.scoring.horizon_days}d`);
  const llama = await fetchLlamaAdvisory();
  console.log("Scanning pools (on-chain canonical)...");
  const { blockNumber, snapshots, pricesUsd } = await scanPools(cfg, client, llama);
  const scanId = store.beginScan(blockNumber);
  for (const s of snapshots) store.insertSnapshot(scanId, s);

  const eligibleCount = snapshots.filter((s) => s.eligible).length;
  console.log(`Scoring ${eligibleCount} eligible pools (fee history, vol, emissions, width optimizer)...`);
  const { scores, aero, gas } = await scorePools(cfg, client, store, snapshots, pricesUsd, blockNumber);

  const gasGwei = Number(gas.gasPriceWei) / 1e9;
  console.log(
    `\nBlock ${blockNumber} | gas ${gasGwei.toFixed(4)} gwei | ETH ${fmtUsd(gas.ethUsd)} | AERO ${
      aero ? "$" + aero.spotUsd.toFixed(4) : "UNPRICED"
    } | position size ${fmtUsd(positionSizeUsd(cfg))}`,
  );

  const H = cfg.scoring.horizon_days;
  const header = [
    "PAIR".padEnd(11),
    "TS".padEnd(5),
    "ARM".padEnd(10),
    "WIDTH".padEnd(8),
    "VOL".padEnd(13),
    `GROSS/${H}d`.padEnd(10),
    `LVR/${H}d`.padEnd(9),
    `REBAL/${H}d`.padEnd(10),
    "ENTRY+EXIT".padEnd(11),
    `NET/${H}d`.padEnd(9),
    "NET APR".padEnd(8),
    "FLAGS",
  ].join(" ");
  console.log("\n" + header);
  console.log("-".repeat(header.length + 6));

  for (const sc of scores) {
    const c = sc.choice;
    const widthPct = c ? ((c.widthMult - 1) * 100).toFixed(1) + "%" : "-";
    const arm = c ? (c.arm === "emissions_staked" ? "stake🅔" : "fees") : "-";
    const vol = `${(sc.volAnnual * 100).toFixed(0)}% ${sc.volSource === "fallback" ? "(fb!)" : `(${sc.volSource.slice(0, 6)})`}`;
    console.log(
      [
        sc.snapshot.pair.padEnd(11),
        String(sc.snapshot.tickSpacing).padEnd(5),
        arm.padEnd(10),
        ("±" + widthPct).padEnd(8),
        vol.padEnd(13),
        (c ? "$" + c.grossUsdHorizon.toFixed(2) : "-").padEnd(10),
        (c ? "$" + c.lvrUsdHorizon.toFixed(2) : "-").padEnd(9),
        (c ? `$${c.rebalanceCostUsdHorizon.toFixed(2)}(${c.rebalancesPerHorizon.toFixed(1)}x)` : "-").padEnd(10),
        (c ? "$" + c.entryExitCostUsd.toFixed(2) : "-").padEnd(11),
        (c ? "$" + c.netUsdHorizon.toFixed(2) : "-").padEnd(9),
        (sc.neyAprPct !== null ? sc.neyAprPct.toFixed(1) + "%" : "-").padEnd(8),
        sc.flags.join(",") || "-",
      ].join(" "),
    );

    store.insertScore({
      ts: Date.now(),
      block: Number(blockNumber),
      pool: sc.snapshot.pool,
      pair: sc.snapshot.pair,
      tickSpacing: sc.snapshot.tickSpacing,
      positionUsd: sc.positionUsd,
      arm: c?.arm ?? null,
      widthMult: c?.widthMult ?? null,
      grossUsdH: c?.grossUsdHorizon ?? null,
      lvrUsdH: c?.lvrUsdHorizon ?? null,
      rebalCostUsdH: c?.rebalanceCostUsdHorizon ?? null,
      entryExitUsd: c?.entryExitCostUsd ?? null,
      netUsdH: c?.netUsdHorizon ?? null,
      neyAprPct: sc.neyAprPct,
      volAnnual: sc.volAnnual,
      volSource: sc.volSource,
      flags: sc.flags,
      details: {
        leverage: c?.leverage,
        inRange: c?.inRangeFraction,
        rebalances: c?.rebalancesPerHorizon,
        feeWindowH: sc.feeWindowHours,
        feeConf: sc.feeConfidence,
        onchainGrossAprPct: sc.onchainGrossAprPct,
        llamaApyPct: sc.llamaApyPct,
        grossRaw: c?.grossUsdHorizonRaw,
      },
    });
    audit.record("score", sc.snapshot.pool, "SCORED", {
      pair: sc.snapshot.pair,
      tickSpacing: sc.snapshot.tickSpacing,
      arm: c?.arm ?? null,
      widthMult: c?.widthMult ?? null,
      netUsdHorizon: c?.netUsdHorizon ?? null,
      neyAprPct: sc.neyAprPct,
      flags: sc.flags,
    });
  }

  // --- Allocation suggestion (paper only — Phase 8 executes) -------------
  const viable = scores.filter(
    (s) =>
      s.choice &&
      s.choice.netUsdHorizon > 0 &&
      (s.neyAprPct ?? -1) >= cfg.scoring.min_net_yield_apr &&
      !s.flags.includes("ADVISORY_APY_UNRECONCILED"),
  );
  if (viable.length > 0) {
    const top = viable[0]!;
    console.log(
      `\nTop allocation candidate: ${top.snapshot.pair} (ts=${top.snapshot.tickSpacing}) — ` +
        `${top.choice!.arm}, ±${((top.choice!.widthMult - 1) * 100).toFixed(1)}%, ` +
        `projected net ${"$" + top.choice!.netUsdHorizon.toFixed(2)}/${H}d on ${fmtUsd(top.positionUsd)} ` +
        `(${top.neyAprPct!.toFixed(1)}% APR). Paper mode — no execution.`,
    );
    audit.record("allocation_suggestion", top.snapshot.pool, "SUGGESTED", {
      pair: top.snapshot.pair,
      arm: top.choice!.arm,
      widthMult: top.choice!.widthMult,
      positionUsd: top.positionUsd,
      netUsdHorizon: top.choice!.netUsdHorizon,
      mode: cfg.mode,
    });
  } else {
    console.log("\nNo pool clears the minimum net yield threshold — correct answer is to stay out.");
    audit.record("allocation_suggestion", "none", "NO_VIABLE_POOL", {});
  }
  store.close();
}

async function cmdBacktest(configPath: string, args: string[]) {
  const cfg = loadConfig(configPath);
  const daysFlag = args.indexOf("--days");
  const days = daysFlag >= 0 ? Number(args[daysFlag + 1]) : cfg.backtest.days;
  const stepFlag = args.indexOf("--step-hours");
  if (stepFlag >= 0) cfg.backtest.step_hours = Number(args[stepFlag + 1]);
  const client = makeClient(cfg);
  const store = new Store(cfg.db.path);
  const audit = new AuditLog(store, cfg.audit.jsonl_path);

  console.log(`Backtest: ${days}d window, ${cfg.backtest.step_hours}h step, capital ${fmtUsd(cfg.capital_usdc)} (no-lookahead replay)`);
  console.log("Discovering pools (current scan defines the tracked set)...");
  const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
  const aero = await discoverAeroPricing(client, cfg);
  const ethUsd = pricesUsd["WETH"];
  if (!ethUsd) throw new Error("No WETH price — cannot price gas");
  const gas = { gasPriceWei: await client.getGasPrice(), ethUsd };

  const hist = await fetchHistory(
    cfg, client, store, snapshots, aero,
    { days, stepHours: cfg.backtest.step_hours },
    (m) => console.log(m),
  );

  // Honesty check: how much of the requested window did the RPC actually serve?
  const usable = hist.blocks.filter((b) =>
    hist.tracked.some((t) => hist.samples.get(t.pool.toLowerCase())?.has(b)),
  );
  if (usable.length < hist.blocks.length * 0.5) {
    console.log(
      `\n⚠ RPC served only ${usable.length}/${hist.blocks.length} sample blocks — ` +
        `results cover a shorter window than requested. Configure an archive RPC for full depth.`,
    );
  }

  console.log("\nReplaying strategy (trailing-data-only decisions)...");
  // Apply the live emission-regime gate as-of (no lookahead), so the backtest
  // reflects the same strategy that runs in production.
  const regimeOracle =
    cfg.regime.enabled && !args.includes("--no-regime")
      ? await buildHistoricalRegimeOracle(cfg.regime.baseline_lookback_days, cfg.regime.min_ratio)
      : undefined;
  const res = runBacktest(cfg, store, hist, gas, (m) => console.log(m), { regimeOracle });

  const H = cfg.scoring.horizon_days;
  console.log(
    `\n${"PAIR".padEnd(11)} ${"ARM".padEnd(10)} ${"WIDTH".padEnd(7)} ${"DAYS".padEnd(5)} ` +
      `PRED/${H}d   ALPHA/${H}d  RAW/${H}d   FEES    EMIS    ΔVALUE   COSTS   REBAL`,
  );
  for (const e of res.entries) {
    console.log(
      `${e.pair.padEnd(11)} ${e.arm.replace("_", " ").padEnd(10)} ${("±" + ((e.widthMult - 1) * 100).toFixed(1) + "%").padEnd(7)} ` +
        `${e.daysHeld.toFixed(1).padEnd(5)} ${("$" + e.predictedNetUsdH.toFixed(2)).padEnd(9)} ${("$" + e.realizedAlphaUsdH.toFixed(2)).padEnd(10)} ${("$" + e.realizedNetUsdH.toFixed(2)).padEnd(9)} ` +
        `${("$" + e.feesUsd.toFixed(2)).padEnd(7)} ${("$" + e.emissionsUsd.toFixed(2)).padEnd(7)} ` +
        `${("$" + e.valueChangeUsd.toFixed(2)).padEnd(8)} ${("$" + e.costsUsd.toFixed(2)).padEnd(7)} ${e.rebalances}`,
    );
  }
  console.log(
    "  (ALPHA = LP result minus holding the entry inventory — the model predicts alpha, not market direction)",
  );
  const ret = res.finalEquityUsd - res.startCapitalUsd;
  const aprPct = (ret / res.startCapitalUsd) * (365 / res.daysSimulated) * 100;
  console.log(
    `\nFinal equity ${fmtUsd(res.finalEquityUsd)} on ${fmtUsd(res.startCapitalUsd)} over ${res.daysSimulated.toFixed(1)}d ` +
      `(net ${ret >= 0 ? "+" : ""}$${ret.toFixed(2)}, ~${aprPct.toFixed(1)}% APR), total costs $${res.totalCostsUsd.toFixed(2)}`,
  );
  console.log(`\nModel validation: ${res.verdict.grade}`);
  for (const n of res.verdict.notes) console.log(`  - ${n}`);
  if (res.verdict.grade !== "PASS") {
    console.log("  => Do NOT proceed to live execution until this passes (per the phase gate).");
  }
  audit.record("backtest", "portfolio", res.verdict.grade, {
    days: res.daysSimulated,
    finalEquity: res.finalEquityUsd,
    entries: res.entries.length,
    totalCosts: res.totalCostsUsd,
    notes: res.verdict.notes,
  });
  store.close();
}

async function cmdMonitor(configPath: string, args: string[]) {
  const cfg = loadConfig(configPath);
  const client = makeClient(cfg);
  const store = new Store(cfg.db.path);
  const audit = new AuditLog(store, cfg.audit.jsonl_path);
  const alerts = new Alerts(cfg);
  const watch = args.includes("--watch");

  const runOnce = async () => {
    const { blockNumber, snapshots, pricesUsd } = await scanPools(cfg, client, null);
    const aero = await discoverAeroPricing(client, cfg);
    console.log(
      `[${new Date().toISOString()}] block ${blockNumber} | ETH ${fmtUsd(pricesUsd["WETH"] ?? 0)} | AERO ${
        aero ? "$" + aero.spotUsd.toFixed(4) : "?"
      }`,
    );

    // Emission-regime baseline (refresh if stale; fail-open on error).
    let regimeBaseline = loadRegimeBaseline(cfg);
    if (
      cfg.regime.enabled &&
      (!regimeBaseline || (Date.now() - regimeBaseline.asOf) / 3_600_000 > cfg.regime.max_staleness_hours / 2)
    ) {
      try {
        regimeBaseline = await refreshRegimeBaseline(cfg, (m) => console.log("  " + m));
      } catch (e) {
        console.log(`  regime refresh failed (${e instanceof Error ? e.message : e}) — fail-open`);
      }
    }
    const regimeOk = (pair: string): boolean => {
      const r = isRegimeFavorable(cfg, regimeBaseline, pair, Date.now());
      if (!r.favorable) console.log(`  regime gate: ${pair} ${r.reason}`);
      return r.favorable;
    };

    // --- paper positions: check, then run the full decision stack ---------
    const open = store.getOpenPaperPositions();
    if (open.length === 0) {
      console.log("  No open paper positions.");
    }
    // Fresh scores drive the still-worth-it gate, switching, and auto-open.
    const { scores, gas } = await scorePools(cfg, client, store, snapshots, pricesUsd, blockNumber);
    // Persist each cycle's scores so the dashboard (and the model's own
    // history) stay current while watching — not only on manual `score` runs.
    for (const sc of scores) {
      store.insertScore({
        ts: Date.now(),
        block: Number(blockNumber),
        pool: sc.snapshot.pool,
        pair: sc.snapshot.pair,
        tickSpacing: sc.snapshot.tickSpacing,
        positionUsd: sc.positionUsd,
        arm: sc.choice?.arm ?? null,
        widthMult: sc.choice?.widthMult ?? null,
        grossUsdH: sc.choice?.grossUsdHorizon ?? null,
        lvrUsdH: sc.choice?.lvrUsdHorizon ?? null,
        rebalCostUsdH: sc.choice?.rebalanceCostUsdHorizon ?? null,
        entryExitUsd: sc.choice?.entryExitCostUsd ?? null,
        netUsdH: sc.choice?.netUsdHorizon ?? null,
        neyAprPct: sc.neyAprPct,
        volAnnual: sc.volAnnual,
        volSource: sc.volSource,
        flags: sc.flags,
        details: { source: "monitor" },
      });
    }
    const pricingForScore = (sc: PoolScore): PoolPricing | null => {
      const p0 = pricesUsd[sc.snapshot.symbol0];
      const p1 = pricesUsd[sc.snapshot.symbol1];
      if (p0 === undefined || p1 === undefined) return null;
      return {
        sqrtPriceX96: sc.snapshot.sqrtPriceX96,
        dec0: cfg.allowlist.tokens[sc.snapshot.symbol0]!.decimals,
        dec1: cfg.allowlist.tokens[sc.snapshot.symbol1]!.decimals,
        p0Usd: p0,
        p1Usd: p1,
      };
    };

    for (const p of open) {
      const c = await checkPaperPosition(cfg, client, store, p, snapshots, pricesUsd, aero);
      const pnl = c.valueUsd + c.feesUsd + c.pendingAeroUsd - p.positionUsd;
      const flags: string[] = [];
      if (!c.inRange) flags.push(`OUT_OF_RANGE${c.sustainedOutMinutes !== null ? ` ${c.sustainedOutMinutes.toFixed(0)}min` : ""}`);
      if (c.beyondDeadband) flags.push("BEYOND_DEADBAND");
      console.log(
        `  paper #${p.id} ${p.pair} ${p.arm} [${p.tickLower},${p.tickUpper}] tick=${c.tickNow} ` +
          `${c.inRange ? "IN-RANGE" : "OUT"} edge ${c.edgeDistancePct.toFixed(2)}% | ` +
          `value ${"$" + c.valueUsd.toFixed(2)} fees ${"$" + c.feesUsd.toFixed(2)} ` +
          `aero ${"$" + c.pendingAeroUsd.toFixed(2)} | uPnL ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} ` +
          `(pred $${p.predictedNetUsdH.toFixed(2)}/${cfg.scoring.horizon_days}d)${flags.length ? " | " + flags.join(",") : ""}`,
      );
      audit.record("monitor", p.pool, c.inRange ? "IN_RANGE" : "OUT_OF_RANGE", {
        paperId: p.id,
        tick: c.tickNow,
        valueUsd: c.valueUsd,
        feesUsd: c.feesUsd,
        pendingAeroUsd: c.pendingAeroUsd,
        beyondDeadband: c.beyondDeadband,
        sustainedOutMinutes: c.sustainedOutMinutes,
      });

      // --- decision stack (paper executes automatically; live is P8) ------
      const snap = snapshots.find((s) => s.pool.toLowerCase() === p.pool.toLowerCase());
      if (!snap) continue;
      const [sym0, sym1] = p.pair.split("/") as [string, string];
      const pricing: PoolPricing = {
        sqrtPriceX96: snap.sqrtPriceX96,
        dec0: cfg.allowlist.tokens[sym0]!.decimals,
        dec1: cfg.allowlist.tokens[sym1]!.decimals,
        p0Usd: pricesUsd[sym0]!,
        p1Usd: pricesUsd[sym1]!,
      };
      const freshScore =
        scores.find((s) => s.snapshot.pool.toLowerCase() === p.pool.toLowerCase()) ?? null;

      // 0. RISK TRIGGERS — exit-now, bypassing all gates (Phase 7).
      const risk = await checkRiskTriggers(
        cfg, store, p.pool, p.pair, snap.tvlUsdc, freshScore?.volAnnual ?? null,
      );
      for (const d of risk.degraded) console.log(`    (risk check degraded: ${d})`);
      if (risk.triggers.length > 0) {
        audit.record("risk_trigger", p.pool, "EXIT_NOW", { paperId: p.id, triggers: risk.triggers });
        await alerts.critical(`PAPER RISK EXIT ${p.pair} #${p.id}: ${risk.triggers.join("; ")}`);
        const res = closePaperPosition(cfg, store, audit, c, snap, pricesUsd, gas, `RISK: ${risk.triggers.join("; ")}`);
        console.log(
          `    -> RISK EXIT (${risk.triggers.join("; ")}): realized net ${res.realizedNetUsd >= 0 ? "+" : ""}$${res.realizedNetUsd.toFixed(2)}`,
        );
        continue;
      }

      // 1–4. Rebalance gate stack (Phase 5).
      const decision = evaluateRebalance(
        cfg, store, `paper:${p.id}`,
        { ...c, ageMs: Date.now() - p.openedTs },
        freshScore, snap, pricing, gas,
      );
      audit.record("rebalance_decision", p.pool, decision.action.toUpperCase(), {
        paperId: p.id,
        reasons: decision.reasons,
        costUsd: decision.costUsd,
        projectedNetUsdH: decision.projectedNetUsdH,
      });
      if (decision.action === "rebalance") {
        const r = executePaperRebalance(
          cfg, store, audit, c, freshScore!, snap, pricing, decision.costUsd!,
        );
        console.log(
          `    -> REBALANCED to [${r.tickLower},${r.tickUpper}] ±${((r.widthMult - 1) * 100).toFixed(1)}% ` +
            `(cost $${decision.costUsd!.toFixed(2)}): ${decision.reasons[0]}`,
        );
        continue;
      }
      if (decision.action === "exit") {
        const res = closePaperPosition(cfg, store, audit, c, snap, pricesUsd, gas, decision.reasons.join("; "));
        console.log(
          `    -> EXITED (${decision.reasons[0]}): realized net ${res.realizedNetUsd >= 0 ? "+" : ""}$${res.realizedNetUsd.toFixed(2)}, ` +
            `ledger entry written`,
        );
        continue;
      }
      if (decision.action === "blocked") {
        console.log(`    -> no action: ${decision.reasons[0]}`);
      }

      // 5. SWITCH evaluation (Phase 6) — only for held positions.
      const sw = evaluateSwitch(
        cfg,
        { pool: p.pool, pair: p.pair, valueUsd: c.valueUsd, ageMs: Date.now() - p.openedTs },
        freshScore, viableScores(scores, cfg, regimeOk), pricingForScore, pricing, snap, gas,
      );
      audit.record("switch_decision", p.pool, sw.action.toUpperCase(), {
        paperId: p.id,
        reasons: sw.reasons,
        target: sw.target?.snapshot.pool ?? null,
        advantageUsdH: sw.advantageUsdH,
        roundTripCostUsd: sw.roundTripCostUsd,
      });
      if (sw.action === "switch") {
        const res = closePaperPosition(cfg, store, audit, c, snap, pricesUsd, gas, sw.reasons.join("; "));
        console.log(
          `    -> SWITCHING out (${sw.reasons[0]}): realized net ${res.realizedNetUsd >= 0 ? "+" : ""}$${res.realizedNetUsd.toFixed(2)}`,
        );
        const id = openPaperPosition(cfg, store, audit, sw.target!, blockNumber, gas, pricesUsd);
        console.log(`    -> opened paper #${id}: ${sw.target!.snapshot.pair} (switch target)`);
      } else if (sw.target) {
        console.log(`    -> staying: ${sw.reasons[0]}`);
      }
    }

    // 6. AUTO-OPEN up to max_positions across DIFFERENT pools, within capital.
    {
      const held = store.getOpenPaperPositions();
      const heldPools = new Set(held.map((x) => x.pool.toLowerCase()));
      let deployed = held.reduce((a, x) => a + x.positionUsd, 0);
      let opened = 0;
      for (const cand of viableScores(scores, cfg, regimeOk)) {
        if (heldPools.size + 0 >= cfg.position.max_positions) break;
        const pool = cand.snapshot.pool.toLowerCase();
        if (heldPools.has(pool)) continue;
        const size = cand.choice!.sizeUsd;
        if (deployed + size > cfg.capital_usdc) continue; // capital exhausted
        const id = openPaperPosition(cfg, store, audit, cand, blockNumber, gas, pricesUsd);
        heldPools.add(pool);
        deployed += size;
        opened++;
        console.log(
          `  AUTO-OPENED paper #${id}: ${cand.snapshot.pair} $${size} ` +
            `±${((cand.choice!.widthMult - 1) * 100).toFixed(1)}% pred $${cand.choice!.netUsdHorizon.toFixed(2)}/${cfg.scoring.horizon_days}d ` +
            `(${heldPools.size}/${cfg.position.max_positions} positions, $${Math.round(deployed)}/${cfg.capital_usdc} deployed)`,
        );
      }
      if (heldPools.size === 0 && opened === 0) {
        console.log("  No pool clears the entry bar — staying in cash (auto-open idle).");
      }
    }

    // --- on-chain positions (read-only; needs BOT_ADDRESS) ------------------
    const owner = resolveOwner(cfg.wallet.address_env);
    if (owner) {
      const positions = await fetchOnchainPositions(client, owner, snapshots);
      if (positions.length === 0) console.log(`  No on-chain positions for ${owner}.`);
      for (const pos of positions) {
        const snap = snapshots.find((s) => s.pool === pos.pool);
        const inRange = snap ? snap.tick >= pos.tickLower && snap.tick < pos.tickUpper : null;
        console.log(
          `  chain #${pos.tokenId} ${pos.pair ?? "unknown pool"} [${pos.tickLower},${pos.tickUpper}] ` +
            `${pos.staked ? "STAKED" : "unstaked"} L=${pos.liquidity} ` +
            `${inRange === null ? "" : inRange ? "IN-RANGE" : "OUT-OF-RANGE"}` +
            `${pos.pendingAero !== null ? ` pending ${(Number(pos.pendingAero) / 1e18).toFixed(2)} AERO` : ""}`,
        );
      }
    } else {
      console.log(`  (set ${cfg.wallet.address_env} to monitor on-chain positions)`);
    }

    // --- validation-gate watch: one-shot alert the moment it turns green ----
    // Rides this already-running process (no extra scheduler). A marker file
    // makes it fire exactly once; deleting the marker re-arms it.
    {
      const v = store.getValidationStats();
      const e2 = cfg.execution;
      const green =
        v.entries >= e2.validation_min_entries &&
        v.signAgreement >= e2.validation_min_sign_agreement &&
        Number.isFinite(v.meanRatio) &&
        v.meanRatio >= e2.validation_ratio_min &&
        v.meanRatio <= e2.validation_ratio_max;
      const marker = `${dirname(cfg.db.path)}/.gate-green`;
      console.log(
        `  GATE: ${v.entries}/${e2.validation_min_entries} trades · accuracy ${(v.signAgreement * 100).toFixed(0)}% (need ${e2.validation_min_sign_agreement * 100}%) · ` +
          `ratio ${Number.isFinite(v.meanRatio) ? v.meanRatio.toFixed(2) : "n/a"} · ${green ? "🟢 GREEN" : "locked"}`,
      );
      if (green && !existsSync(marker)) {
        writeFileSync(marker, new Date().toISOString());
        await alerts.critical(
          `🟢 VALIDATION GATE GREEN — strategy validated on live paper ` +
            `(${v.entries} trades, ${(v.signAgreement * 100).toFixed(0)}% accuracy, ${v.meanRatio.toFixed(2)}x). ` +
            `Real money can now be unlocked per GO-LIVE.md (first deploy capped $${cfg.position.max_position_usd ?? "?"}).`,
        );
      }
    }
  };

  await runOnce();
  if (watch) {
    const base = cfg.rebalance.check_interval_minutes * 60_000;
    const loop = async () => {
      // jitter so on-chain observers can't set their watch by us
      const jitter = (Math.random() * 2 - 1) * cfg.rebalance.timing_jitter_minutes * 60_000;
      setTimeout(async () => {
        try {
          await runOnce();
        } catch (e) {
          console.error("monitor check failed:", e instanceof Error ? e.message : e);
        }
        void loop();
      }, base + jitter);
    };
    console.log(`\nWatching (every ~${cfg.rebalance.check_interval_minutes}min ± jitter). Ctrl-C to stop.`);
    void loop();
  } else {
    store.close();
  }
}

async function cmdPaperOpen(configPath: string, args: string[] = []) {
  const cfg = loadConfig(configPath);
  const client = makeClient(cfg);
  const store = new Store(cfg.db.path);
  const audit = new AuditLog(store, cfg.audit.jsonl_path);

  const poolFlag = args.indexOf("--pool");
  const targetPool = poolFlag >= 0 ? args[poolFlag + 1]?.toLowerCase() : null;

  const existing = store.getOpenPaperPositions();
  if (existing.length >= cfg.position.max_positions) {
    console.log(`Refusing: already at max_positions (${cfg.position.max_positions}).`);
    store.close();
    return;
  }
  if (targetPool && existing.some((p) => p.pool.toLowerCase() === targetPool)) {
    console.log("Refusing: a position in that pool is already open.");
    store.close();
    return;
  }

  const llama = await fetchLlamaAdvisory();
  const { blockNumber, snapshots, pricesUsd } = await scanPools(cfg, client, llama);
  const { scores, gas } = await scorePools(cfg, client, store, snapshots, pricesUsd, blockNumber);
  let viable = viableScores(scores, cfg);
  if (targetPool) {
    viable = viable.filter((s) => s.snapshot.pool.toLowerCase() === targetPool);
    if (viable.length === 0) {
      console.log("That pool does not currently clear the entry bar — not opening.");
      store.close();
      return;
    }
  }
  if (viable.length === 0) {
    console.log("No pool clears the minimum net yield threshold — not opening. (Correct answer is to stay out.)");
    audit.record("paper_open", "none", "NO_VIABLE_POOL", {});
    store.close();
    return;
  }
  const top = viable[0]!;
  const id = openPaperPosition(cfg, store, audit, top, blockNumber, gas, pricesUsd);
  console.log(
    `Opened paper #${id}: ${top.snapshot.pair} (ts=${top.snapshot.tickSpacing}) ${top.choice!.arm} ` +
      `±${((top.choice!.widthMult - 1) * 100).toFixed(1)}% on ${fmtUsd(top.positionUsd)} — ` +
      `predicted $${top.choice!.netUsdHorizon.toFixed(2)}/${cfg.scoring.horizon_days}d (${top.neyAprPct!.toFixed(1)}% APR). ` +
      `Run 'npm run monitor' to track it.`,
  );
  store.close();
}

async function cmdPaperClose(configPath: string, args: string[]) {
  const cfg = loadConfig(configPath);
  const client = makeClient(cfg);
  const store = new Store(cfg.db.path);
  const audit = new AuditLog(store, cfg.audit.jsonl_path);

  const idArg = args.find((a) => /^\d+$/.test(a));
  const open = store.getOpenPaperPositions();
  const target = idArg ? open.find((p) => p.id === Number(idArg)) : open[0];
  if (!target) {
    console.log(idArg ? `No open paper position #${idArg}.` : "No open paper positions.");
    store.close();
    return;
  }

  const { snapshots, pricesUsd } = await scanPools(cfg, client, null);
  const aero = await discoverAeroPricing(client, cfg);
  const gas = { gasPriceWei: await client.getGasPrice(), ethUsd: pricesUsd["WETH"]! };
  const check = await checkPaperPosition(cfg, client, store, target, snapshots, pricesUsd, aero);
  const snap = snapshots.find((s) => s.pool.toLowerCase() === target.pool.toLowerCase())!;
  const res = closePaperPosition(cfg, store, audit, check, snap, pricesUsd, gas, "manual close");
  console.log(
    `Closed paper #${target.id} ${target.pair}: realized net ${res.realizedNetUsd >= 0 ? "+" : ""}$${res.realizedNetUsd.toFixed(2)}, ` +
      `alpha $${res.realizedAlphaUsdH.toFixed(2)}/${cfg.scoring.horizon_days}d vs predicted $${target.predictedNetUsdH.toFixed(2)}/${cfg.scoring.horizon_days}d. ` +
      `Ledger entry written (model validation data).`,
  );
  store.close();
}

async function cmdLive(configPath: string, args: string[]) {
  const cfg = loadConfig(configPath);
  const store = new Store(cfg.db.path);
  const audit = new AuditLog(store, cfg.audit.jsonl_path);
  const alerts = new Alerts(cfg);

  // --- the refusal gates, in order of cheapness ---------------------------
  if (cfg.mode !== "live") {
    throw new Error('config mode is not "live" — set mode: live in config.yaml (two-key safety, 1/2).');
  }
  if (!args.includes("--live")) {
    throw new Error("missing --live flag (two-key safety, 2/2).");
  }
  assertValidationPassed(cfg, store); // the phase gate, enforced in code
  const signer = makeSigner(cfg); // throws without the env key
  const client = makeClient(cfg);
  await verifySwapRouter(client); // refuse an unverified router
  console.log(`live signer: ${signer.address} (dedicated bot wallet expected)`);

  // --- reconciliation BEFORE any decision ---------------------------------
  const { snapshots, pricesUsd, blockNumber } = await scanPools(cfg, client, null);
  const report = await reconcile(cfg, client, store, audit, alerts, signer.address, snapshots);
  console.log(
    `reconcile: ${report.positionsOnchain} on-chain position(s), ${report.adopted.length} adopted, ` +
      `${report.phantoms.length} phantom(s), wallet ${fmtUsd(report.usdcBalance)} USDC, ` +
      `${report.unfinishedActions} unfinished action(s)`,
  );
  // Resume interrupted/halted actions before anything new.
  const machine = new ExecutionMachine(store, audit, (m) => console.log(m));
  const usdcAddr = cfg.allowlist.tokens["USDC"]!.address;
  const aeroSnapshot = null; // routes rebuilt per cycle inside runLiveCycle
  const routes = buildRoutes(cfg, snapshots, aeroSnapshot);
  for (const a of machine.unfinished()) {
    console.log(`resuming action #${a.id} (${a.kind}, was ${a.status})...`);
    const status =
      a.kind === "enter"
        ? await machine.run(a.id, enterSteps(cfg, signer, usdcAddr, routes, (m) => console.log(m)))
        : await machine.run(a.id, exitSteps(cfg, signer, usdcAddr, routes, (m) => console.log(m)));
    if (status === "halted") {
      await alerts.critical(`Action #${a.id} (${a.kind}) is still HALTED after resume — refusing to proceed.`);
      store.close();
      process.exit(1);
    }
    if (a.kind === "enter") {
      const done = store.getAction(a.id)!.context as EnterCtx;
      if (done.tokenId) store.upsertLivePosition(done.tokenId, done.pool, done.pair, done.arm);
    } else {
      const done = store.getAction(a.id)!.context as ExitCtx;
      store.closeLivePosition(done.tokenId);
    }
  }

  // --- decision loop with timing jitter ------------------------------------
  await alerts.info(`Live bot started: ${signer.address}, capital target ${fmtUsd(cfg.capital_usdc)}.`);
  const cycle = async () => {
    const fresh = await scanPools(cfg, client, null);
    await runLiveCycle(
      cfg, client, store, audit, alerts, signer, machine,
      fresh.snapshots, fresh.pricesUsd, fresh.blockNumber, (m) => console.log(m),
    );
  };
  await cycle();
  const loop = () => {
    const base = cfg.rebalance.check_interval_minutes * 60_000;
    const jitter = (Math.random() * 2 - 1) * cfg.rebalance.timing_jitter_minutes * 60_000;
    setTimeout(async () => {
      try {
        await cycle();
      } catch (e) {
        await alerts.critical(`live cycle error: ${e instanceof Error ? e.message : e}`);
      }
      loop();
    }, base + jitter);
  };
  console.log(`looping every ~${cfg.rebalance.check_interval_minutes}min ± jitter. Ctrl-C to stop.`);
  loop();
}

async function cmdDiscover() {
  const { discoverPockets } = await import("../data/discover.js");
  const pockets = await discoverPockets();
  console.log("Pocket candidates across audited venues (DeFiLlama, ADVISORY — verify on-chain):\n");
  console.log(
    `${"VENUE".padEnd(26)} ${"PAIR".padEnd(16)} ${"TVL".padEnd(11)} ${"REWARD APY".padEnd(11)} PRIZE $/day/$1k`,
  );
  for (const p of pockets.slice(0, 20)) {
    console.log(
      `${p.venue.padEnd(26)} ${p.symbol.padEnd(16)} ${("$" + Math.round(p.tvlUsd).toLocaleString()).padEnd(11)} ` +
        `${(p.rewardApyPct.toFixed(0) + "%").padEnd(11)} $${p.prizeDensity.toFixed(2)}`,
    );
  }
  if (pockets.length === 0) console.log("(none currently match the pocket profile)");
}

const [, , command, ...rest] = process.argv;
const configFlag = rest.indexOf("--config");
const configPath = configFlag >= 0 ? rest[configFlag + 1]! : "config.yaml";

switch (command) {
  case "scan":
    cmdScan(configPath).catch((e) => {
      console.error("Scan failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;
  case "score":
    cmdScore(configPath).catch((e) => {
      console.error("Score failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;
  case "backtest":
    cmdBacktest(configPath, rest).catch((e) => {
      console.error("Backtest failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;
  case "monitor":
    cmdMonitor(configPath, rest).catch((e) => {
      console.error("Monitor failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;
  case "paper-open":
    cmdPaperOpen(configPath, rest).catch((e) => {
      console.error("paper-open failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;
  case "paper-close":
    cmdPaperClose(configPath, rest).catch((e) => {
      console.error("paper-close failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;
  case "discover":
    cmdDiscover().catch((e) => {
      console.error("discover failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;
  case "live":
    cmdLive(configPath, rest).catch((e) => {
      console.error("live refused/failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
    break;
  default:
    console.log(
      "Usage: tsx src/cli/index.ts <scan|score|backtest|monitor|paper-open|paper-close> [--config path] [--days N] [--watch]",
    );
    process.exit(command ? 1 : 0);
}
