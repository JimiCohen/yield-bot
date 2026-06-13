import type { Config } from "../config/schema.js";
import type { Store } from "../data/store.js";
import {
  bridgeTouchProb,
  liquidityForUsd,
  positionValueUsd,
  sRaw,
  swapImpactFraction,
  type PoolPricing,
} from "../scoring/clmath.js";
import { optimizeWidth, type GasContext, type WidthChoice } from "../scoring/optimizer.js";
import type { AeroPricing } from "../scoring/emissions.js";
import type { History, HistSample, TrackedPool } from "./history.js";

/**
 * No-lookahead strategy replay over sampled on-chain history.
 *
 * At each decision point the engine scores pools using ONLY trailing data
 * (fee growth over the prior 24h, EWMA vol over the prior 72h, reward rate
 * and AERO price as of that block) — the same logic as the live scorer.
 * Between samples, position value is computed EXACTLY (CL position value is
 * path-independent between rebalances), fees accrue from actual
 * feeGrowthGlobal deltas, and emissions from actual rewardRate, valued at
 * the ACTUAL AERO price path at compounding time — so realized emission
 * decay is real, not assumed.
 *
 * Realism requirements honored:
 *  - gas: live Base gas price applied to every action
 *  - slippage: virtual-reserve impact at the pool's HISTORICAL liquidity,
 *    scaled to our position size (own-impact included)
 *  - emission decay: actual AERO price path
 *  - survivorship: all discovered pools tracked; filters applied as-of
 *
 * Documented approximations:
 *  - In-range fraction between samples uses a Brownian-bridge touch
 *    probability (full accrual is haircut by half the touch probability).
 *  - Hard filter at-time-t is TVL-only; historical gauge alive/killed state
 *    is not reconstructable, so rewardRate>0 proxies "emissions alive".
 *  - The sustain gate is implicit: the sample step (>= 45min) means an
 *    out-of-range reading has persisted at least one step.
 */

const LN_TICK = Math.log(1.0001);

interface ScoredAt {
  tp: TrackedPool;
  choice: WidthChoice;
  pricing: PoolPricing;
  vol: number;
}

interface OpenPosition {
  tp: TrackedPool;
  arm: "fees_unstaked" | "emissions_staked";
  positionUsd: number; // optimizer-chosen size at entry
  widthMult: number;
  L: number;
  saRaw: number;
  sbRaw: number;
  entryIdx: number;
  entryTs: number;
  predictedNetUsdH: number;
  predictedGrossUsdH: number; // predicted yield arm (emissions or fees)
  predictedLvrUsdH: number; // predicted divergence/LVR cost
  feesUsd: number;
  pendingAero: number;
  emissionsUsd: number;
  costsUsd: number;
  rebalances: number;
  rebalTimes: number[];
  entryValueUsd: number;
  /** entry inventory (raw units) — the HODL benchmark for alpha isolation */
  entryAmt0: number;
  entryAmt1: number;
}

export interface BacktestEntryResult {
  pair: string;
  pool: string;
  arm: string;
  widthMult: number;
  entryTs: number;
  daysHeld: number;
  predictedNetUsdH: number;
  predictedGrossUsdH: number;
  predictedLvrUsdH: number;
  realizedNetUsd: number;
  realizedNetUsdH: number; // scaled to the horizon for comparability
  /**
   * Realized LP ALPHA vs holding the entry inventory: strips market beta,
   * which the zero-drift NEY model deliberately does not predict. This —
   * not raw P&L — is what validates the model. An LP position is ~half
   * long the risky asset; raw P&L in a trending window is mostly beta.
   */
  realizedAlphaUsd: number;
  realizedAlphaUsdH: number;
  feesUsd: number;
  emissionsUsd: number;
  valueChangeUsd: number;
  costsUsd: number;
  rebalances: number;
}

export interface BacktestResult {
  entries: BacktestEntryResult[];
  finalEquityUsd: number;
  startCapitalUsd: number;
  daysSimulated: number;
  totalCostsUsd: number;
  verdict: { grade: "PASS" | "WARN" | "FAIL"; notes: string[] };
}

export function runBacktest(
  cfg: Config,
  store: Store,
  hist: History,
  gas: GasContext,
  log: (m: string) => void,
  opts: {
    /** Experiment mode: always hold the best-scoring pool regardless of
     *  the entry bar. Isolates position-management effects (rebalance
     *  cadence, width choice) from entry timing. NOT a strategy. */
    forceEntry?: boolean;
    /** Experiment mode: pin the range width (e.g. 1.01 = ±1%) instead of
     *  the optimizer's choice — required to study rebalance cadence on
     *  tight ranges the optimizer refuses to pick. NOT a strategy. */
    forceWidthMult?: number;
    /** Experiment mode: allocate to this pair (e.g. "USDC/cbBTC") instead
     *  of the best-scoring pool. NOT a strategy. */
    forcePool?: string;
    /** Experiment mode: recenter whenever beyond the deadband at a check,
     *  bypassing the rate-limit and net-benefit gates — simulates the naive
     *  "always rebalance back into range" policy. NOT a strategy. */
    forceRebalance?: boolean;
  } = {},
): BacktestResult {
  const H = cfg.scoring.horizon_days;
  const stepHours =
    hist.blocks.length > 1
      ? (hist.tsForBlock(hist.blocks[1]!) - hist.tsForBlock(hist.blocks[0]!)) / 3_600_000
      : 2;
  const stepDays = stepHours / 24;
  const feeWindowSteps = Math.max(1, Math.round(24 / stepHours));
  const volWindowSteps = Math.max(4, Math.round(72 / stepHours));
  // Score/switch/enter decisions at the SAME cadence the live monitor uses
  // (check_interval_minutes), not a fixed daily tick — a daily tick gave a
  // 3-day window only two decision points and starved the replay of entries.
  const decisionSteps = Math.max(
    1,
    Math.round(cfg.rebalance.check_interval_minutes / 60 / stepHours),
  );
  const warmup = Math.max(feeWindowSteps, 8);

  const sampleAt = (tp: TrackedPool, i: number): HistSample | undefined =>
    hist.samples.get(tp.pool.toLowerCase())?.get(hist.blocks[i]!);

  const budgetUsd = Math.min(
    cfg.capital_usdc,
    Math.max(cfg.capital_usdc * cfg.position.max_pool_fraction, cfg.position.min_position_usd),
  );

  // --- USD prices at sample i, derived from the tracked pools themselves --
  const refPoolFor = new Map<string, TrackedPool>(); // symbol -> ref pool
  for (const tp of hist.tracked) {
    for (const [sym, other] of [
      [tp.symbol0, tp.symbol1],
      [tp.symbol1, tp.symbol0],
    ] as const) {
      if (sym === "USDC" || other !== "USDC") continue;
      const cur = refPoolFor.get(sym);
      const liqNow = sampleAt(tp, hist.blocks.length - 1)?.liquidity ?? 0n;
      const curLiq = cur ? (sampleAt(cur, hist.blocks.length - 1)?.liquidity ?? 0n) : -1n;
      if (liqNow > curLiq) refPoolFor.set(sym, tp);
    }
  }
  const priceUsdAt = (sym: string, i: number): number | null => {
    if (sym === "USDC") return 1;
    const ref = refPoolFor.get(sym);
    if (!ref) return null;
    const s = sampleAt(ref, i);
    if (!s) return null;
    const raw01 = Math.pow(1.0001, s.tick); // token1 raw per token0 raw
    const human01 = raw01 * 10 ** (ref.dec0 - ref.dec1);
    return ref.symbol0 === sym ? human01 : 1 / human01;
  };
  const pricingAt = (tp: TrackedPool, i: number): PoolPricing | null => {
    const s = sampleAt(tp, i);
    const p0 = priceUsdAt(tp.symbol0, i);
    const p1 = priceUsdAt(tp.symbol1, i);
    if (!s || p0 === null || p1 === null) return null;
    return { sqrtPriceX96: s.sqrtPriceX96, dec0: tp.dec0, dec1: tp.dec1, p0Usd: p0, p1Usd: p1 };
  };
  const aeroAt = (i: number): AeroPricing | null => {
    if (!hist.aeroTracked) return null;
    const s = sampleAt(hist.aeroTracked, i);
    if (!s) return null;
    const t = hist.aeroTracked;
    const raw01 = Math.pow(1.0001, s.tick) * 10 ** (t.dec0 - t.dec1);
    const spotUsd = t.symbol0 === "AERO" ? raw01 : 1 / raw01;
    return {
      spotUsd,
      poolFeeFraction: t.feePips / 1e6,
      pool: t.pool,
      liquidity: s.liquidity,
      pricing: {
        sqrtPriceX96: s.sqrtPriceX96,
        dec0: t.dec0,
        dec1: t.dec1,
        p0Usd: t.symbol0 === "AERO" ? spotUsd : 1,
        p1Usd: t.symbol0 === "AERO" ? 1 : spotUsd,
      },
    };
  };

  // --- trailing estimators (no lookahead) ---------------------------------
  const volAt = (tp: TrackedPool, i: number): number => {
    const lambda = cfg.volatility.ewma_lambda;
    const floor = cfg.volatility.fallback_annual[tp.pair] ?? cfg.volatility.fallback_default;
    let v: number | null = null;
    let n = 0;
    for (let j = Math.max(1, i - volWindowSteps); j <= i; j++) {
      const a = sampleAt(tp, j - 1);
      const b = sampleAt(tp, j);
      if (!a || !b) continue;
      const dt = stepHours * 3600;
      const r = (b.tick - a.tick) * LN_TICK;
      const varPerSec = (r * r) / dt;
      v = v === null ? varPerSec : lambda * v + (1 - lambda) * varPerSec;
      n++;
    }
    if (v === null || n < 4) return floor;
    // Floor at the config vol: short-memory EWMA reads calm spells as
    // safety and licenses tight widths right before vol expands (vol
    // clusters). The floor is the long-run prior; EWMA can only raise it.
    return Math.max(Math.sqrt(v * 31_536_000), floor);
  };

  // Empirical in-range fraction (NO lookahead): walk trailing ticks under a
  // recenter-on-exit policy and measure the fraction of steps the position
  // would have been in range. Real paths mean-revert/stick far more than GBM,
  // so this corrects the model's ~2x over-credit of emission capture.
  const etaWindowSteps = Math.max(8, Math.round((7 * 24) / stepHours));
  const inRangeEmpiricalAt = (tp: TrackedPool, i: number, mEff: number): number => {
    const hwTicks = Math.log(mEff) / LN_TICK; // band half-width in ticks
    if (!(hwTicks > 0)) return 1;
    const start = Math.max(0, i - etaWindowSteps);
    let center: number | null = null;
    let inRange = 0;
    let total = 0;
    for (let j = start; j <= i; j++) {
      const s = sampleAt(tp, j);
      if (!s) continue;
      if (center === null) {
        center = s.tick;
        continue;
      }
      total++;
      if (Math.abs(s.tick - center) <= hwTicks) inRange++;
      else center = s.tick; // recenter on exit (rate limits ignored: 1st-order)
    }
    if (total < 4) return NaN; // too little history — caller keeps GBM eta
    return inRange / total;
  };

  const feeRateAt = (tp: TrackedPool, i: number, pricing: PoolPricing) => {
    const now = sampleAt(tp, i);
    const past = sampleAt(tp, i - feeWindowSteps);
    if (!now || !past) return null;
    const d0 = Number(now.fg0 - past.fg0) / 2 ** 128;
    const d1 = Number(now.fg1 - past.fg1) / 2 ** 128;
    const usdPerLiq =
      d0 * (pricing.p0Usd / 10 ** pricing.dec0) + d1 * (pricing.p1Usd / 10 ** pricing.dec1);
    const days = (feeWindowSteps * stepHours) / 24;
    return {
      usdPerLiquidityPerDay: usdPerLiq / days,
      windowHours: feeWindowSteps * stepHours,
      confidence: "high" as const,
    };
  };

  const scoreAt = (i: number): ScoredAt[] => {
    const aero = aeroAt(i);
    const out: ScoredAt[] = [];
    for (const tp of hist.tracked) {
      const s = sampleAt(tp, i);
      const pricing = pricingAt(tp, i);
      if (!s || !pricing) continue;
      const tvl =
        Number(s.bal0) / 10 ** tp.dec0 * pricing.p0Usd +
        Number(s.bal1) / 10 ** tp.dec1 * pricing.p1Usd;
      if (tvl <= cfg.filters.min_tvl_usdc) continue; // hard filter, as-of
      // Gauge-alive is a hard filter in the live strategy regardless of
      // which arm earns — apply the same rule as-of (periodFinish current
      // = gauge still receiving epochs). Without this, deprecated pools
      // kept qualifying through the fee arm.
      const emissionsAlive = s.rewardRate > 0n && s.periodFinish > s.ts / 1000;
      if (cfg.filters.require_alive_gauge && !emissionsAlive) continue;
      const vol = volAt(tp, i);
      const choice = optimizeWidth({
        budgetUsd,
        minSizeUsd: cfg.position.min_position_usd,
        pricing,
        tickSpacing: tp.tickSpacing,
        poolFeeFraction: tp.feePips / 1e6,
        poolLiquidity: s.liquidity,
        pairHasUsdc: tp.symbol0 === "USDC" || tp.symbol1 === "USDC",
        feeRate: feeRateAt(tp, i, pricing),
        unstakedLiquidity: Number(s.liquidity - s.stakedLiquidity),
        // Emissions are flowing ONLY while ts < periodFinish. A killed gauge
        // keeps returning its last rewardRate forever; trusting it manufactured
        // phantom yield on dead pools in early testing.
        emissions: emissionsAlive
          ? {
              aeroPerDayGauge: (Number(s.rewardRate) / 1e18) * 86400,
              stakedLiquidity: s.stakedLiquidity,
            }
          : null,
        aero,
        vol: { annual: vol, source: "local_samples", confidence: "medium", samples: volWindowSteps },
        // Empirical in-range fraction: OPT-IN only. A/B over dense-data
        // windows showed it improves level-calibration but DEGRADES ranking
        // and profit (it steers off the tight-band emission carry where
        // prediction is actually good). GBM eta wins on trustworthy data, so
        // it stays the default; the empirical path remains for experiments.
        inRangeFor: process.env.EMP_ETA
          ? (mEff: number) => inRangeEmpiricalAt(tp, i, mEff)
          : undefined,
        cfg,
        gas,
      });
      if (choice && process.env.BT_DEBUG) {
        const L = liquidityForUsd(pricing, choice.sizeUsd, choice.widthMult);
        console.log(
          `    DBG ${tp.pair} ts${tp.tickSpacing} i=${i} p0=${pricing.p0Usd.toFixed(2)} p1=${pricing.p1Usd.toFixed(2)} ` +
            `vol=${(vol * 100).toFixed(1)}% m=${choice.widthMult.toFixed(3)} L=${L.toExponential(2)} ` +
            `staked=${Number(s.stakedLiquidity).toExponential(2)} share=${(L / (Number(s.stakedLiquidity) + L)).toExponential(2)} ` +
            `aero=${aero ? aero.spotUsd.toFixed(4) : "-"} rate=${Number(s.rewardRate).toExponential(2)} ` +
            `gross=${choice.grossUsdHorizonRaw.toFixed(2)} net=${choice.netUsdHorizon.toFixed(2)}`,
        );
      }
      if (choice) out.push({ tp, choice, pricing, vol });
    }
    out.sort((a, b) => b.choice.netUsdHorizon - a.choice.netUsdHorizon);
    return out;
  };

  // --- cost helpers --------------------------------------------------------
  const gasUsd = (units: number) => units * Number(gas.gasPriceWei) * 1e-18 * gas.ethUsd;
  const swapCostUsd = (tp: TrackedPool, i: number, amountUsd: number): number => {
    const s = sampleAt(tp, i);
    const pricing = pricingAt(tp, i);
    if (!s || !pricing) return amountUsd * 0.01; // missing data: charge 1%
    return amountUsd * (tp.feePips / 1e6 + swapImpactFraction(s.liquidity, pricing, amountUsd));
  };
  const swapFraction = (tp: TrackedPool) =>
    tp.symbol0 === "USDC" || tp.symbol1 === "USDC" ? 0.5 : 1.0;

  // --- replay ---------------------------------------------------------------
  let cash = cfg.capital_usdc;
  let pos: OpenPosition | null = null;
  const entries: BacktestEntryResult[] = [];
  let totalCosts = 0;
  let lastScores: ScoredAt[] = [];

  const posValue = (p: OpenPosition, i: number): number => {
    const pricing = pricingAt(p.tp, i);
    if (!pricing) return p.entryValueUsd;
    return positionValueUsd(p.L, p.saRaw, p.sbRaw, sRaw(pricing.sqrtPriceX96), pricing);
  };

  const closePosition = (p: OpenPosition, i: number, reason: string) => {
    const value = posValue(p, i);
    const exitCost = gasUsd(cfg.gas.exit_gas_units) + swapCostUsd(p.tp, i, swapFraction(p.tp) * value);
    // Pending AERO realized at exit-time price, swap costs charged.
    // NOTE: p.emissionsUsd is NOT added here — compounded emissions were
    // reinvested into L and are already inside `value` (it's a report-only
    // figure); adding it again double-counted compounding in early testing.
    const aero = aeroAt(i);
    const pendingUsd = aero
      ? p.pendingAero * aero.spotUsd * (1 - aero.poolFeeFraction)
      : 0;
    const proceeds = value + p.feesUsd + pendingUsd - exitCost;
    const costs = p.costsUsd + exitCost;
    totalCosts += exitCost;
    cash += proceeds;
    const daysHeld = Math.max(stepDays, (hist.tsForBlock(hist.blocks[i]!) - p.entryTs) / 86_400_000);
    const net = proceeds - p.positionUsd;
    // HODL benchmark: entry inventory valued at exit prices.
    const exitPricing = pricingAt(p.tp, i);
    const hodlUsd = exitPricing
      ? p.entryAmt0 * (exitPricing.p0Usd / 10 ** p.tp.dec0) +
        p.entryAmt1 * (exitPricing.p1Usd / 10 ** p.tp.dec1)
      : p.entryValueUsd;
    const alpha = proceeds - hodlUsd - (p.positionUsd - p.entryValueUsd);
    entries.push({
      pair: p.tp.pair,
      pool: p.tp.pool,
      arm: p.arm,
      widthMult: p.widthMult,
      entryTs: p.entryTs,
      daysHeld,
      predictedNetUsdH: p.predictedNetUsdH,
      predictedGrossUsdH: p.predictedGrossUsdH,
      predictedLvrUsdH: p.predictedLvrUsdH,
      realizedNetUsd: net,
      realizedNetUsdH: (net / daysHeld) * H,
      realizedAlphaUsd: alpha,
      realizedAlphaUsdH: (alpha / daysHeld) * H,
      feesUsd: p.feesUsd,
      emissionsUsd: p.emissionsUsd + pendingUsd,
      valueChangeUsd: value - p.entryValueUsd,
      costsUsd: costs,
      rebalances: p.rebalances,
    });
    log(
      `  [${new Date(p.entryTs).toISOString().slice(0, 10)}] close ${p.tp.pair} (${reason}): ` +
        `net $${net.toFixed(2)} (alpha $${alpha.toFixed(2)}) over ${daysHeld.toFixed(1)}d ` +
        `(pred $${p.predictedNetUsdH.toFixed(2)}/${H}d, fees $${p.feesUsd.toFixed(2)}, ` +
        `emis $${(p.emissionsUsd + pendingUsd).toFixed(2)}, ΔV $${(value - p.entryValueUsd).toFixed(2)}, ` +
        `costs $${costs.toFixed(2)}, ${p.rebalances} rebal)`,
    );
  };

  const openPosition = (sc: ScoredAt, i: number): OpenPosition => {
    const widthMult = opts.forceWidthMult ?? sc.choice.widthMult;
    const sizeUsd = sc.choice.sizeUsd;
    const entryCost =
      gasUsd(cfg.gas.enter_gas_units) + swapCostUsd(sc.tp, i, swapFraction(sc.tp) * sizeUsd);
    const deployed = sizeUsd - entryCost;
    const L = liquidityForUsd(sc.pricing, deployed, widthMult);
    const s = sRaw(sc.pricing.sqrtPriceX96);
    const sa = s / Math.sqrt(widthMult);
    const sb = s * Math.sqrt(widthMult);
    cash -= sizeUsd;
    totalCosts += entryCost;
    const p: OpenPosition = {
      tp: sc.tp,
      arm: sc.choice.arm,
      positionUsd: sizeUsd,
      widthMult,
      L,
      saRaw: sa,
      sbRaw: sb,
      entryAmt0: L * (1 / s - 1 / sb),
      entryAmt1: L * (s - sa),
      entryIdx: i,
      entryTs: hist.tsForBlock(hist.blocks[i]!),
      predictedNetUsdH: sc.choice.netUsdHorizon,
      predictedGrossUsdH: sc.choice.grossUsdHorizon,
      predictedLvrUsdH: sc.choice.lvrUsdHorizon,
      feesUsd: 0,
      pendingAero: 0,
      emissionsUsd: 0,
      costsUsd: entryCost,
      rebalances: 0,
      rebalTimes: [],
      entryValueUsd: deployed,
    };
    log(
      `  [${new Date(p.entryTs).toISOString().slice(0, 10)}] open ${sc.tp.pair} ${sc.choice.arm} ` +
        `±${((widthMult - 1) * 100).toFixed(1)}% pred $${sc.choice.netUsdHorizon.toFixed(2)}/${H}d ` +
        `(entry cost $${entryCost.toFixed(2)})`,
    );
    return p;
  };

  for (let i = warmup; i < hist.blocks.length; i++) {
    const tsNow = hist.tsForBlock(hist.blocks[i]!);

    // --- accrual over the step just elapsed -------------------------------
    if (pos && i > pos.entryIdx) {
      const p: OpenPosition = pos;
      const cur = sampleAt(p.tp, i - 1);
      const nxt = sampleAt(p.tp, i);
      const pricing = pricingAt(p.tp, i);
      if (cur && nxt && pricing) {
        const xa = Math.log(p.saRaw * p.saRaw);
        const xb = Math.log(p.sbRaw * p.sbRaw);
        const x0 = cur.tick * LN_TICK;
        const x1 = nxt.tick * LN_TICK;
        const in0 = x0 > xa && x0 < xb;
        const in1 = x1 > xa && x1 < xb;
        let inFrac = 0;
        if (in0 && in1) {
          const sigma = volAt(p.tp, i);
          const sigmaSqDt = sigma * sigma * (stepHours / 8760);
          inFrac = 1 - 0.5 * bridgeTouchProb(x0, x1, xa, xb, sigmaSqDt);
        } else if (in0 || in1) {
          inFrac = 0.5;
        }
        if (inFrac > 0) {
          if (p.arm === "fees_unstaked") {
            const d0 = Number(nxt.fg0 - cur.fg0) / 2 ** 128;
            const d1 = Number(nxt.fg1 - cur.fg1) / 2 ** 128;
            p.feesUsd +=
              (d0 * (pricing.p0Usd / 10 ** p.tp.dec0) +
                d1 * (pricing.p1Usd / 10 ** p.tp.dec1)) *
              p.L *
              inFrac;
          } else if (nxt.periodFinish > nxt.ts / 1000) {
            const share = p.L / (Number(nxt.stakedLiquidity) + p.L);
            p.pendingAero +=
              (Number(nxt.rewardRate) / 1e18) * (stepHours * 3600) * share * inFrac;
          }
        }

        // --- compounding (auto-compound, threshold-gated) ------------------
        const aero = aeroAt(i);
        if (aero && p.pendingAero > 0) {
          const grossUsd = p.pendingAero * aero.spotUsd;
          const impact = swapImpactFraction(aero.liquidity, aero.pricing, grossUsd);
          const netUsd = grossUsd * (1 - aero.poolFeeFraction) * (1 - impact);
          const cost = gasUsd(cfg.gas.compound_gas_units);
          if (netUsd >= cfg.compound.min_cost_multiple * cost) {
            const v = posValue(p, i);
            if (v > 0) {
              p.L *= (v + netUsd - cost) / v; // reinvest proportionally
              p.emissionsUsd += netUsd - cost;
              p.costsUsd += cost;
              totalCosts += cost;
              p.pendingAero = 0;
            }
          }
        }

        // --- rebalance check (deadband + rate limit + net benefit) ---------
        const db = cfg.rebalance.deadband_fraction;
        const halfWidth = Math.log(p.widthMult);
        const center = (xa + xb) / 2;
        const beyondDeadband = Math.abs(x1 - center) > halfWidth * (1 + db);
        if (beyondDeadband) {
          const dayAgo = tsNow - 86_400_000;
          const recent = p.rebalTimes.filter((t) => t > dayAgo).length;
          const myScore = lastScores.find(
            (s2) => s2.tp.pool === p.tp.pool && s2.choice.arm === p.arm,
          );
          const v = posValue(p, i);
          const cost = gasUsd(cfg.gas.rebalance_gas_units) + swapCostUsd(p.tp, i, v / 2);
          const projected = myScore?.choice.netUsdHorizon ?? 0;
          if (
            opts.forceRebalance ||
            (recent < cfg.rebalance.max_rebalances_per_day &&
              projected >= cfg.rebalance.net_benefit_margin * cost)
          ) {
            // recenter; width recomputed from the latest scoring if available
            const newWidth = opts.forceWidthMult ?? myScore?.choice.widthMult ?? p.widthMult;
            const sNow = sRaw(pricing.sqrtPriceX96);
            p.L = liquidityForUsd(pricing, v - cost, newWidth);
            p.widthMult = newWidth;
            p.saRaw = sNow / Math.sqrt(newWidth);
            p.sbRaw = sNow * Math.sqrt(newWidth);
            p.costsUsd += cost;
            totalCosts += cost;
            p.rebalances++;
            p.rebalTimes.push(tsNow);
          }
        }
      }
    }

    // --- decision cadence: rescore, maybe enter/switch ---------------------
    if ((i - warmup) % decisionSteps === 0 || (!pos && lastScores.length === 0)) {
      lastScores = scoreAt(i);
      // Entry requires clearing the minimum net yield threshold, not just
      // positivity — entering on a $0.03/7d prediction is noise trading.
      // (forceEntry experiment mode bypasses the bar: best pool, always.)
      const forced = opts.forcePool
        ? lastScores.filter(
            (s) =>
              s.tp.pair === opts.forcePool ||
              s.tp.pool.toLowerCase() === opts.forcePool!.toLowerCase(),
          )
        : lastScores;
      const viable = opts.forceEntry
        ? forced.slice(0, 1)
        : lastScores.filter(
            (s) =>
              s.choice.netUsdHorizon > 0 &&
              (s.choice.netUsdHorizon / s.choice.sizeUsd) * (365 / H) * 100 >=
                cfg.scoring.min_net_yield_apr,
          );
      const best = viable[0];
      if (!pos && best) {
        pos = openPosition(best, i);
      } else if (
        pos &&
        best &&
        best.tp.pool !== pos.tp.pool &&
        hist.tsForBlock(hist.blocks[i]!) - pos.entryTs >=
          cfg.rebalance.min_hold_minutes * 60_000
      ) {
        const p: OpenPosition = pos;
        const v = posValue(p, i);
        const roundTrip =
          gasUsd(cfg.gas.exit_gas_units + cfg.gas.enter_gas_units) +
          swapCostUsd(p.tp, i, swapFraction(p.tp) * v) +
          swapCostUsd(best.tp, i, swapFraction(best.tp) * v);
        const current = lastScores.find((s) => s.tp.pool === p.tp.pool);
        const advantage = best.choice.netUsdHorizon - (current?.choice.netUsdHorizon ?? 0);
        if (advantage > cfg.rebalance.switch_margin * roundTrip) {
          closePosition(p, i, `switch to ${best.tp.pair}`);
          pos = openPosition(best, i);
        }
      }
    }
  }

  if (pos) {
    closePosition(pos, hist.blocks.length - 1, "end of window");
    pos = null;
  }

  // --- validation verdict ---------------------------------------------------
  const notes: string[] = [];
  let grade: BacktestResult["verdict"]["grade"] = "PASS";
  if (entries.length === 0) {
    grade = "FAIL";
    notes.push("No entries simulated — nothing validated.");
  } else {
    // Validation compares predicted NEY against realized ALPHA (LP result
    // minus HODL-the-entry-inventory). Raw P&L includes market beta, which
    // the zero-drift model does not and cannot predict.
    const signAgree =
      entries.filter((e) => Math.sign(e.realizedAlphaUsdH) === Math.sign(e.predictedNetUsdH))
        .length / entries.length;
    const ratios = entries
      .filter((e) => Math.abs(e.predictedNetUsdH) > 0.5)
      .map((e) => e.realizedAlphaUsdH / e.predictedNetUsdH);
    const meanRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : NaN;
    notes.push(`alpha sign agreement ${(signAgree * 100).toFixed(0)}% over ${entries.length} entries`);
    if (!Number.isNaN(meanRatio)) notes.push(`mean alpha/predicted ratio ${meanRatio.toFixed(2)}`);
    if (signAgree < 0.5 || (ratios.length >= 3 && meanRatio < 0.2)) grade = "FAIL";
    else if (signAgree < 0.7 || (ratios.length >= 3 && (meanRatio < 0.4 || meanRatio > 2.5)))
      grade = "WARN";
    if (entries.length < 4)
      notes.push(`only ${entries.length} entries — low statistical power, treat as indicative`);
  }

  const daysSimulated = ((hist.blocks.length - warmup) * stepHours) / 24;
  const result: BacktestResult = {
    entries,
    finalEquityUsd: cash,
    startCapitalUsd: cfg.capital_usdc,
    daysSimulated,
    totalCostsUsd: totalCosts,
    verdict: { grade, notes },
  };
  const runId = store.insertBacktestRun(
    { days: daysSimulated, stepHours, capital: cfg.capital_usdc },
    { finalEquity: cash, totalCosts, verdict: result.verdict },
  );
  for (const e of entries) {
    store.insertBacktestEntry(runId, {
      entryTs: e.entryTs,
      pool: e.pool,
      pair: e.pair,
      arm: e.arm,
      widthMult: e.widthMult,
      daysHeld: e.daysHeld,
      predictedNetUsdH: e.predictedNetUsdH,
      realizedNetUsdH: e.realizedAlphaUsdH, // validation ledger stores alpha
      feesUsd: e.feesUsd,
      emissionsUsd: e.emissionsUsd,
      valueChangeUsd: e.valueChangeUsd,
      costsUsd: e.costsUsd,
      rebalances: e.rebalances,
    });
  }
  return result;
}
