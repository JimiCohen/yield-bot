import type { Config } from "../config/schema.js";
import type { ChainClient } from "../chain/client.js";
import type { Store } from "../data/store.js";
import type { AuditLog } from "../audit/log.js";
import type { Alerts } from "../alerts/telegram.js";
import { AERODROME } from "../chain/addresses.js";
import { PERIPHERY } from "../chain/addresses.js";
import { positionManagerAbi } from "../chain/abis.js";
import { positionValueUsd, type PoolPricing } from "../scoring/clmath.js";
import { scorePools, viableScores, positionSizeUsd, type PoolScore } from "../scoring/netYield.js";
import { evaluateRebalance } from "../strategy/rebalance.js";
import { evaluateSwitch } from "../strategy/switch.js";
import { checkRiskTriggers } from "../strategy/risk.js";
import { ExecutionMachine } from "./machine.js";
import { enterSteps, exitSteps, type EnterCtx, type ExitCtx, type SwapRoutes } from "./actions.js";
import type { makeSigner } from "./signer.js";
import type { PoolSnapshot } from "../types.js";

/**
 * Live decision cycle — Phase 8. Identical decision stack to the paper
 * loop (risk -> rebalance gates -> switch -> auto-open); the only
 * difference is the executor: capital moves through the persistent,
 * idempotent state machine, and every execution alerts.
 */

const LN_TICK = Math.log(1.0001);

export function buildRoutes(cfg: Config, snapshots: PoolSnapshot[], aeroPool: { pool: string; tickSpacing?: number } | null): SwapRoutes {
  const usdcAddr = cfg.allowlist.tokens["USDC"]!.address.toLowerCase();
  const routes: SwapRoutes = {};
  for (const [sym, t] of Object.entries(cfg.allowlist.tokens)) {
    if (sym === "USDC") continue;
    // deepest eligible token/USDC pool by TVL
    const candidates = snapshots
      .filter(
        (s) =>
          s.eligible &&
          ((s.token0.toLowerCase() === t.address.toLowerCase() && s.token1.toLowerCase() === usdcAddr) ||
            (s.token1.toLowerCase() === t.address.toLowerCase() && s.token0.toLowerCase() === usdcAddr)),
      )
      .sort((a, b) => b.tvlUsdc - a.tvlUsdc);
    if (candidates[0]) {
      routes[t.address.toLowerCase()] = {
        pool: candidates[0].pool,
        tickSpacing: candidates[0].tickSpacing,
        router: PERIPHERY[candidates[0].factory.toLowerCase()]!.swapRouter,
      };
    }
  }
  if (aeroPool) {
    routes[AERODROME.aero.toLowerCase()] = {
      pool: aeroPool.pool,
      tickSpacing: aeroPool.tickSpacing ?? 200,
      router: PERIPHERY[AERODROME.clFactory.toLowerCase()]!.swapRouter,
    };
  }
  return routes;
}

function enterCtxFromScore(cfg: Config, top: PoolScore, usdcRaw: bigint): EnterCtx {
  const s = top.snapshot;
  const choice = top.choice!;
  // Hard live position cap — clamp BEFORE building the entry, so it bounds
  // auto-open, rebalance re-entry, and switch alike. First real trades stay
  // small even if the wallet is over-funded or the optimizer wants more.
  if (cfg.position.max_position_usd !== undefined) {
    const usdc = cfg.allowlist.tokens["USDC"]!;
    const capRaw = BigInt(Math.floor(cfg.position.max_position_usd * 10 ** usdc.decimals));
    if (usdcRaw > capRaw) usdcRaw = capRaw;
  }
  const halfWidthTicks = Math.log(choice.widthMult) / LN_TICK;
  const snapTick = (t: number) => Math.round(t / s.tickSpacing) * s.tickSpacing;
  let tickLower = snapTick(s.tick - halfWidthTicks);
  let tickUpper = snapTick(s.tick + halfWidthTicks);
  if (tickUpper <= tickLower) tickUpper = tickLower + s.tickSpacing;
  return {
    pool: s.pool,
    npm: PERIPHERY[s.factory.toLowerCase()]!.positionManager,
    pair: s.pair,
    arm: choice.arm,
    gauge: s.gauge,
    token0: s.token0,
    token1: s.token1,
    dec0: cfg.allowlist.tokens[s.symbol0]!.decimals,
    dec1: cfg.allowlist.tokens[s.symbol1]!.decimals,
    tickSpacing: s.tickSpacing,
    tickLower,
    tickUpper,
    usdcIn: usdcRaw.toString(),
  };
}

export async function runLiveCycle(
  cfg: Config,
  client: ChainClient,
  store: Store,
  audit: AuditLog,
  alerts: Alerts,
  signer: ReturnType<typeof makeSigner>,
  machine: ExecutionMachine,
  snapshots: PoolSnapshot[],
  pricesUsd: Record<string, number>,
  blockNumber: bigint,
  log: (m: string) => void,
): Promise<void> {
  const usdcAddr = cfg.allowlist.tokens["USDC"]!.address;
  const { scores, gas, aero } = await scorePools(cfg, client, store, snapshots, pricesUsd, blockNumber);
  const routes = buildRoutes(cfg, snapshots, aero ? { pool: aero.pool } : null);
  const viable = viableScores(scores, cfg);

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

  const runExit = async (tokenId: string, pool: string, npm: string, pair: string, gauge: string | null, t0: string, t1: string, reason: string) => {
    await alerts.critical(`LIVE EXIT ${pair} #${tokenId}: ${reason}`);
    const ctx: ExitCtx = { tokenId, pool, npm, pair, gauge, token0: t0, token1: t1 };
    const id = machine.begin("exit", ctx);
    const status = await machine.run(id, exitSteps(cfg, signer, usdcAddr, routes, log));
    if (status === "done") store.closeLivePosition(tokenId);
    else await alerts.critical(`LIVE EXIT #${tokenId} HALTED — manual attention required.`);
    return status;
  };

  for (const lp of store.getOpenLivePositions()) {
    const snap = snapshots.find((s) => s.pool.toLowerCase() === lp.pool.toLowerCase());
    if (!snap) continue;
    const pos = (await client.readContract({
      address: PERIPHERY[snap.factory.toLowerCase()]!.positionManager as `0x${string}`,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [BigInt(lp.tokenId)],
    })) as readonly [bigint, string, string, string, number, number, number, bigint, ...unknown[]];
    const [, , , , , tickLower, tickUpper, liquidity] = pos;
    if (liquidity === 0n) {
      store.closeLivePosition(lp.tokenId);
      continue;
    }
    const [sym0, sym1] = lp.pair.split("/") as [string, string];
    const pricing: PoolPricing = {
      sqrtPriceX96: snap.sqrtPriceX96,
      dec0: cfg.allowlist.tokens[sym0]!.decimals,
      dec1: cfg.allowlist.tokens[sym1]!.decimals,
      p0Usd: pricesUsd[sym0]!,
      p1Usd: pricesUsd[sym1]!,
    };
    const sNow = Number(snap.sqrtPriceX96) / 2 ** 96;
    const valueUsd = positionValueUsd(
      Number(liquidity),
      Math.pow(1.0001, tickLower / 2),
      Math.pow(1.0001, tickUpper / 2),
      sNow,
      pricing,
    );
    const inRange = snap.tick >= tickLower && snap.tick < tickUpper;
    const center = (tickLower + tickUpper) / 2;
    const beyondDeadband =
      Math.abs(snap.tick - center) >
      ((tickUpper - tickLower) / 2) * (1 + cfg.rebalance.deadband_fraction);
    const key = `live:${lp.tokenId}`;
    const prev = store.getRangeState(key);
    store.setRangeState(
      key,
      inRange ? null : (prev.outSince ?? Date.now()),
      beyondDeadband ? (prev.beyondDeadbandSince ?? Date.now()) : null,
      snap.tick,
    );
    const freshScore =
      scores.find((s) => s.snapshot.pool.toLowerCase() === lp.pool.toLowerCase()) ?? null;

    // 0. risk triggers — exit now
    const risk = await checkRiskTriggers(cfg, store, lp.pool, lp.pair, snap.tvlUsdc, freshScore?.volAnnual ?? null);
    if (risk.triggers.length > 0) {
      await runExit(lp.tokenId, lp.pool, PERIPHERY[snap.factory.toLowerCase()]!.positionManager, lp.pair, snap.gauge, snap.token0, snap.token1, `RISK: ${risk.triggers.join("; ")}`);
      continue;
    }

    // 1–4. rebalance gates
    const check = { inRange, beyondDeadband, valueUsd, ageMs: Date.now() - lp.openedTs };
    const decision = evaluateRebalance(cfg, store, key, check, freshScore, snap, pricing, gas);
    audit.record("rebalance_decision", lp.pool, decision.action.toUpperCase(), {
      live: lp.tokenId, reasons: decision.reasons,
    });
    if (decision.action === "exit") {
      await runExit(lp.tokenId, lp.pool, PERIPHERY[snap.factory.toLowerCase()]!.positionManager, lp.pair, snap.gauge, snap.token0, snap.token1, decision.reasons.join("; "));
      continue;
    }
    if (decision.action === "rebalance") {
      // rebalance = exit + enter, two resumable actions in sequence
      const st = await runExit(lp.tokenId, lp.pool, PERIPHERY[snap.factory.toLowerCase()]!.positionManager, lp.pair, snap.gauge, snap.token0, snap.token1, `REBALANCE: ${decision.reasons[0]}`);
      if (st !== "done") continue;
      const usdcBal = await usdcBalance(client, cfg, signer.address);
      const ctx = enterCtxFromScore(cfg, freshScore!, usdcBal);
      await alerts.critical(`LIVE ENTER ${freshScore!.snapshot.pair} (rebalance re-entry)`);
      const id = machine.begin("enter", ctx);
      const enterStatus = await machine.run(id, enterSteps(cfg, signer, usdcAddr, routes, log));
      if (enterStatus === "done") {
        const done = store.getAction(id)!.context as EnterCtx;
        store.upsertLivePosition(done.tokenId!, ctx.pool, ctx.pair, ctx.arm);
        store.recordRebalanceEvent({
          positionKey: key, costUsd: 0, oldLower: tickLower, oldUpper: tickUpper,
          newLower: ctx.tickLower, newUpper: ctx.tickUpper,
        });
      }
      continue;
    }

    // 5. switch
    const sw = evaluateSwitch(
      cfg, { pool: lp.pool, pair: lp.pair, valueUsd, ageMs: Date.now() - lp.openedTs },
      freshScore, viable, pricingForScore, pricing, snap, gas,
    );
    if (sw.action === "switch") {
      const st = await runExit(lp.tokenId, lp.pool, PERIPHERY[snap.factory.toLowerCase()]!.positionManager, lp.pair, snap.gauge, snap.token0, snap.token1, sw.reasons.join("; "));
      if (st !== "done") continue;
      const usdcBal = await usdcBalance(client, cfg, signer.address);
      const ctx = enterCtxFromScore(cfg, sw.target!, usdcBal);
      await alerts.critical(`LIVE ENTER ${sw.target!.snapshot.pair} (switch target)`);
      const id = machine.begin("enter", ctx);
      const enterStatus = await machine.run(id, enterSteps(cfg, signer, usdcAddr, routes, log));
      if (enterStatus === "done") {
        const done = store.getAction(id)!.context as EnterCtx;
        store.upsertLivePosition(done.tokenId!, ctx.pool, ctx.pair, ctx.arm);
      }
    }
  }

  // 6. auto-open up to max_positions across DIFFERENT pools, wallet-funded.
  {
    const heldPools = new Set(store.getOpenLivePositions().map((x) => x.pool.toLowerCase()));
    const usdc = cfg.allowlist.tokens["USDC"]!;
    for (const top of viable) {
      if (heldPools.size >= cfg.position.max_positions) break;
      if (heldPools.has(top.snapshot.pool.toLowerCase())) continue;
      const sizeUsd = top.choice!.sizeUsd; // optimizer-chosen, <= budget
      const bal = await usdcBalance(client, cfg, signer.address);
      const want = BigInt(Math.floor(sizeUsd * 10 ** usdc.decimals));
      const usdcIn = bal < want ? bal : want;
      if (Number(usdcIn) / 10 ** usdc.decimals < cfg.position.min_position_usd * 0.95) {
        break; // wallet exhausted — stop opening, never scrape dust
      }
      await alerts.critical(
        `LIVE ENTER ${top.snapshot.pair} ±${((top.choice!.widthMult - 1) * 100).toFixed(1)}% ` +
          `$${(Number(usdcIn) / 1e6).toFixed(2)} (pred $${top.choice!.netUsdHorizon.toFixed(2)}/${cfg.scoring.horizon_days}d)`,
      );
      const ctx = enterCtxFromScore(cfg, top, usdcIn);
      const id = machine.begin("enter", ctx);
      const status = await machine.run(id, enterSteps(cfg, signer, usdcAddr, routes, log));
      if (status === "done") {
        const done = store.getAction(id)!.context as EnterCtx;
        store.upsertLivePosition(done.tokenId!, ctx.pool, ctx.pair, ctx.arm);
        heldPools.add(ctx.pool.toLowerCase());
      } else {
        await alerts.critical("LIVE ENTER HALTED — manual attention required.");
        break; // halted action blocks new ones anyway
      }
    }
  }
}

async function usdcBalance(client: ChainClient, cfg: Config, owner: `0x${string}`): Promise<bigint> {
  const usdc = cfg.allowlist.tokens["USDC"]!;
  const { erc20WriteAbi } = await import("../chain/abis.js");
  return (await client.readContract({
    address: usdc.address as `0x${string}`,
    abi: erc20WriteAbi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

/** The phase gate, enforced in code: refuse live without ledger evidence. */
export function assertValidationPassed(cfg: Config, store: Store): void {
  if (!cfg.execution.require_validation) {
    console.warn(
      "⚠ execution.require_validation is OFF — running an UNVALIDATED model with real funds is your explicit choice.",
    );
    return;
  }
  const s = store.getValidationStats();
  const e = cfg.execution;
  const failures: string[] = [];
  if (s.entries < e.validation_min_entries)
    failures.push(`entries ${s.entries} < ${e.validation_min_entries}`);
  if (s.signAgreement < e.validation_min_sign_agreement)
    failures.push(`sign agreement ${(s.signAgreement * 100).toFixed(0)}% < ${e.validation_min_sign_agreement * 100}%`);
  if (Number.isNaN(s.meanRatio) || s.meanRatio < e.validation_ratio_min || s.meanRatio > e.validation_ratio_max)
    failures.push(`alpha/predicted ratio ${Number.isNaN(s.meanRatio) ? "n/a" : s.meanRatio.toFixed(2)} outside [${e.validation_ratio_min}, ${e.validation_ratio_max}]`);
  if (failures.length > 0) {
    throw new Error(
      `Model validation has NOT passed — refusing live execution.\n  ${failures.join("\n  ")}\n` +
        `Accumulate paper entries (npm run monitor -- --watch) until the ledger clears the gate.`,
    );
  }
}
