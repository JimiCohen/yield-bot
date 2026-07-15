# Project Status — read me first in any new session

_Last updated: 2026-07-03. This file is the single source of truth for
"where are we" — update it whenever something material changes._

## ⭐ ALLOCATOR IMPROVEMENT SPRINT (2026-07-15) — GATE NOW OPEN
12 days parked in Steakhouse Prime: **+$1.97, measured 4.07%/yr steady
(2h=24h=7d windows) — the allocator's own live gate is OPEN.** Improvements:
- Venues 4→7 (+Fluid 5.3%, Spark Vault, bbq tier-3) with RISK TIERS
  (max_tier=2 default) + $5M TVL floor; all 7 verified on-chain.
- Guards: G2 drain now ON-CHAIN totalAssets first (caught two of my own wrong
  llama uuids — advisory TVL was a different share class, 60% off); G4 USDC
  depeg (<0.99 advisory); G5 yield-divergence (measured < 40% of advertised).
- LIVE-AWARENESS + AUTO-FLEE: when key present + mode live, guard reads the
  REAL wallet position and auto-withdraws to wallet on drain/stall
  (allocator.auto_flee: true).
- OPS: allocator is a dashboard-supervised task (AUTO_START_ALLOCATOR=1, also
  in Dockerfile) — reboot-orphan failure mode closed. Dashboard 'Honest yield'
  card + /api/allocator + `allocate --report`.
- Remaining for first real dollar (user-only): wallet + USDC on Base +
  BOT_PRIVATE_KEY in .env + mode: live → `allocate --deposit N --live`.
- VPS: re-pull + rebuild to get allocator container-supervised there too.

## ⭐ PARK+GUARD ALLOCATOR — THE HONEST STRATEGY (2026-07-03, WORKING)
Built src/allocator/ (venues/paper/live) after the CL strategy failed live
(see verdict below) and deep-research verified honest yield = 3-6%. Design
from a 365d simulation on real posted rates: rotation adds only ~$2/yr over
parking → PARK in the best audited venue + GUARD it (G1 better-venue
0.75pp/5 checks, G2 TVL-drain 30%/7d, G3 accrual-stall 48h). Accounting =
ON-CHAIN accrual index (ERC4626 convertToAssets 1e24 probe / Aave normalized
income) — measured truth, zero prediction, winner's curse impossible.
VERIFIED WORKING: paper parked $1,500 in Steakhouse Prime USDC (Morpho,
$228M TVL); first 2 minutes accrued +$0.0002 = measured 3.93%/yr from pure
on-chain share-price growth (advertised 4.24%). Guard watcher running hourly
(`npm run allocate -- --watch`, logs/allocator.out).
LIVE PATH BUILT + GATED: `allocate --deposit N --live` / `--withdraw --live`
(two-key: config mode live AND --live flag; code gate requires >=7 days of
MEASURED positive paper accrual — verified to refuse now; caps:
allocator.capital_usd AND position.max_position_usd; exact approvals only).
Expected: ~$60/yr on $1,500 — small, real, deterministic. First REAL dollar
needs only user steps: dedicated wallet + USDC on Base + BOT_PRIVATE_KEY in
.env + mode: live, once the gate opens (~Jul 10).

## LATEST: the 20–23% "accuracy" was a measurement bug, now fixed
Diagnosis of the ledger found THREE defects that made validation garbage-in:
1. **Snap-band phantom P&L** (the big one): `openPaperPosition` sized
   liquidity from the REQUESTED width, then snapped the tick band — when
   snapping widened the band (ts50/ts100 pools), the position was credited
   with up to 1.83x phantom capital. The "+$992.83 in 16 minutes" trade was
   exactly $1,200 × 1.825 at exit. Trade 13's −$46 was the same bug in the
   narrow direction. FIX: band first (deterministic width = multiple of
   spacing, centered), then `liquidityForUsdInBand` (exact inverse of
   `positionValueUsd`). Same fix in `executePaperRebalance`.
2. **Switch churn**: `evaluateSwitch` had no min-hold — bot hopped pools
   every 15-min cycle (5 switches in one afternoon, 5–16 min holds).
   FIX: min_hold_minutes gate in evaluateSwitch + ageMs wired from both
   callers; live rebalance check also now passes ageMs.
3. **Unbuildable widths scored**: optimizer width grid wasn't quantized to
   tick spacing — leverage (and predicted yield) inflated ~2x near
   one-spacing bands (the $525/wk siren that lured the bad switch).
   FIX: `quantizeWidth` in clmath, applied to the grid. SOL/USDC "1,313%
   APR" became 24% after the fix; top pick now WETH/cbBTC ts100 at ~60%.
Validation stats are now HOLD-TIME WEIGHTED (weight = days_held, capped at
horizon; per-entry ratio clamped ±5) in BOTH store.getValidationStats and
server validationStats — keep them mirrored.
The pre-fix ledger rows were measured with a broken ruler → moved to
`paper_entries_quarantined` (audit trail kept). Ledger restarts at 0/8.
SUBTLE: a position OPENED pre-fix but CLOSED post-fix still writes a tainted
row (it carries the buggy entry L/amounts) — local #16 did exactly this after
restart (alpha −$2,946/7d noise). So the cleanup is two parts, both idempotent:
(1) quarantine all existing paper_entries, (2) set status='abandoned' on any
still-open paper_positions so pre-fix opens never write a ledger entry.
'abandoned' is safe — every query filters status='open' (verified). Local DONE
(14 rows quarantined). VPS: run the same via
`docker compose -f docker-compose.paper.yml exec -T bot node -e '<combined script>'`
(better-sqlite3 is in the image; no sqlite3 CLI). No restart needed — db is read live.

## What this is
An automated DeFi yield bot for Aerodrome (Base) + Velodrome (Optimism)
concentrated-liquidity pools. Finds thin-prize "pocket" pools, sizes
positions optimally, rebalances/rotates through safety gates. Full design:
README.md, docs/MODELS.md, SECURITY.md, GO-LIVE.md, DEPLOY.md.

## Where things run RIGHT NOW
- **Cloud (24/7, primary):** Hostinger VPS `srv1752673`, IP `2.25.203.19`,
  Ubuntu 24.04 + Docker. Container `yield-bot-bot-1` from
  `docker-compose.paper.yml`, AUTO_START_PAPER=1. PAPER MODE — no real money,
  no keys on the box. Update procedure: web terminal (hPanel → VPS →
  Terminal) → `cd yield-bot && git pull && docker compose -f
  docker-compose.paper.yml up -d --build`.
  View dashboard: `ssh -L 8787:localhost:8787 root@2.25.203.19` →
  http://localhost:8787
- **Local (Mac):** dashboard at http://127.0.0.1:8787 (`npm run dashboard`,
  AUTO_START_PAPER=1 honored). Desktop launcher "Aerodrome Dashboard.app".
  Velodrome venue: `--config config.velodrome.yaml`, port 8788.
- **Repo:** https://github.com/JimiCohen/yield-bot (PUBLIC — verified
  no secrets; push needs `gh auth setup-git` once per machine).

## LIVE FORWARD-TEST VERDICT (2026-07-02) — FAILED. DO NOT FUND.
~3 weeks of live paper (the unfoolable judge): **18 trades, 18% prediction
accuracy (need 70%), realized P&L ≈ −$128 on $1,500.** The churn fix did NOT
close the backtest-vs-live gap. Post-fix day-long holds show the WINNER'S CURSE
signature: the LARGEST predictions failed worst (pred +$683/wk → alpha −$553;
+$380 → −$505; +$231 → −$122) while small predictions were ~fine — argmax over
noisy NEY estimates systematically selects the most over-estimated cell. The
backtest is flattered because it accrues emissions/fees with the SAME share
model it predicts with (correlated errors); live accrual is real on-chain
deltas. Legitimate vol-spike risk exits also bypassed min_hold (correct
behavior). Ops note: the bot DIED in a reboot (~Jun 18) and position #34 sat
unmanaged 13 days → −$44 of the loss is an ops failure (no persistence; launchd
was auto-blocked earlier — needs explicit user opt-in).
CONCLUSION: strategy as built has NO validated real-money edge. Candidate next
research (NOT promises): shrinkage/uncertainty penalty before argmax to kill
the winner's curse; score-vs-realized calibration from the live ledger itself.
The gate stays locked — that is the system working.

## REGIME TUNE + LIVE CHURN FIX (2026-06-15 latest)
- `npm run regime-sweep`: TRAIN(recent m0-m4)/HELD-OUT(older m5-m9) split. 0.60
  was OVERFIT (best recent worst-month but poor on held-out, +$586, a -$33
  month). Relaxed min_ratio 0.60→0.45: robust on BOTH halves (held-out +$900,
  66% acc, no losing month). Contiguous 365d still PASSES (71%, ratio 0.59).
- LIVE LEDGER hit 9 trades → exposed CHURN: every live hold ~2-4h (at the old
  120min min_hold boundary). "31% acc / -0.51 ratio" was mostly short-hold
  ANNUALIZATION NOISE (entry #24: +$2.04 P&L but -861 annualized alpha on 1.8h),
  not a broken model — but the bot wasn't holding long enough to earn emission
  carry. FIX: min_hold_minutes 120→1440 (24h). Backtest 90d still PASSES (72%,
  29 vs 47 trades, 40% lower costs). Recenter & risk-exit still bypass min_hold.
  Live ledger now re-accumulating with day+ holds; hold-time weighting
  down-weights the old churn entries. WATCH whether live acc climbs now.
- NOTE: live bot was concentrating in WETH/cbBTC (6/9 trades, the low-emission
  correlated pair) rather than the high-emission SOL/USDC the backtest favors —
  worth investigating if live acc stays low after the churn fix (possible
  live-scan vs backtest scoring discrepancy).
- VPS still on min_ratio 0.60 / min_hold 120 (pulled before these commits) —
  re-pull + rebuild to match, or treat local as canonical.

## DEEP BACKTEST — FULL YEAR (2026-06-15, archive RPC)
Contiguous 180/270/365d ALL PASS @6h (71-72% sign, ratio 0.75-0.81, ~+$534
net — note net flat across lengths = idle most of the year, profit concentrated
in favorable windows). 10×30d monthly sweep (each fresh $1,500):
- Regime ON: 8/10 months positive, SUM +$1,990, worst -$57, pooled sign 64%.
- Regime OFF: 9/10 positive, SUM +$2,392, worst -$190, pooled sign 62%.
TAKEAWAYS (honest): (1) PROFIT IS ROBUST across the whole year incl. older
months the tuning never saw (blue-chips only, SOL didn't exist <60d ago) — NOT
just the recent spike. (2) The regime gate is RISK MGMT, not free money: cuts
worst-month drawdown ~3x but costs ~$400/yr upside (min_ratio 0.6 may be a bit
aggressive — candidate to relax, but DON'T overfit; let live inform it).
(3) PER-TRADE ACCURACY is consistently ~62-65%/month both ways — BELOW the 70%
gate; the contiguous-year 71% PASS is a single-path concentration artifact.
(4) Granularity caveat stands: 6h passes, 2h WARNs (67%), LIVE paper 41%.
NET: profitability case is now strong + year-robust; prediction-reliability
(the gate) is the genuine open question — live ledger is the arbiter.

## MONITORING (2026-06-13 latest)
- `npm run progress`: read-only gate report (exact hold-time-weighted gate math
  + fill-rate ETA + per-pool P&L). Exit 0=green / 10=working. Current: 4/8
  trades, LIVE accuracy 41% (need 70%), ratio ~1.0. LIVE accuracy running well
  below backtest (60-74%) — watch this; small sample but a live-vs-backtest gap
  signal. The live paper ledger is the authoritative judge.
- Monitor cycle logs a GATE line each cycle and fires a ONE-SHOT alert (existing
  Alerts/Telegram; logs if unconfigured) when it turns green — marker
  data/.gate-green (gitignored), delete to re-arm. No external scheduler.
- For a phone ping: set Telegram per GO-LIVE.md step 4 → the running bot pushes
  the gate-green alert (and all live trade alerts) automatically.
- launchd daily macOS notification was NOT installed (auto-mode blocked system
  persistence) — offer it as an explicit opt-in if the user wants it.
- Local paper bot is the authoritative gate (current code).
- VPS UPDATED 2026-06-15 (via Hostinger web terminal, browser automation):
  srv1752673/2.25.203.19 fast-forwarded dabc3d2→c9c618d, .env written with
  BASE_ARCHIVE_RPC, `docker compose -f docker-compose.paper.yml up -d --build`,
  old ledger quarantined (52 rows → paper_entries_quarantined, 1 open position
  abandoned). Container yield-bot-bot-1 running latest code, paper 0/8 clean,
  forward-testing the validated config in parallel. (Telegram creds NOT on VPS
  yet — add to /root/yield-bot/.env + recreate container to enable phone pings
  from the cloud bot.)

## GRANULARITY CHECK (2026-06-13 latest) — the 6h PASS was NOT robust
Re-ran at realistic 2h step (live checks at 15min, even finer): 60d nets +$570
(still profitable) but validation = WARN: sign agreement 67% (<70%), ratio 0.22
(over-predicts, <0.4 floor). The 6h PASS came from fewer/longer holds; at finer
resolution the bot trades 3x more (154 vs 47) and the emission over-prediction
returns. Tried conf_emissions haircuts 0.45/0.35/0.25 @2h: profit collapses
(+$570→$84-147) and sign agreement does NOT improve (45-59%). So it's NOT a
tuning miss — per-trade prediction simply isn't reliable enough at trading
cadence. CONCLUSION: backtest confirms the strategy is consistently PROFITABLE
(+$500-570 every run) but does NOT robustly clear the prediction gate at real
granularity. The trustworthy judge is the LIVE PAPER LEDGER (real cadence, real
gates, real on-chain marks) — now filling organically (3/8). Do NOT go live on
the 6h backtest; wait for the paper gate. NOT live-ready.

## ARCHIVE RPC → 6h multi-month backtest (2026-06-13 late) — see granularity caveat above
User supplied a free Alchemy Base archive key (full depth — confirmed reads at
60/180/365d). Injected via `BASE_ARCHIVE_RPC` env in gitignored `.env`
(makeClient prepends it as primary transport; key NEVER committed — repo is
public). This unlocked granular net-alpha backtests months back.

RESULTS (real on-chain granular data, no-lookahead, regime gate ON, 6h step):
- **Contiguous 90/120/150d ALL PASS the validation gate**: 74% sign agreement
  (need 70%), ratio 1.69-1.71 (need 0.4-2.5), +$511 net on $1,500. First real
  PASS on trustworthy multi-month data. Net identical across window lengths =
  strategy correctly IDLES in the older unfavorable stretch (no entries added
  90→150d), not losing.
- Profit DIVERSIFIED across pools (90d): SOL/USDC ~48%, WETH/USDC ~24%,
  WETH/cbBTC ~17%, USDC/cbBTC ~10% — blue chips alone (~52%) still profitable.
- Regime gate A/B (5×30d isolated windows): cuts worst month -$207→-$84 (38→22
  entries), pooled sign 63%→67%, sum +$902→+$914. Drawdown protection works.
- `npm run residuals` now sweeps 5×30d months; REGIME_OFF=1 to A/B. CLI
  `backtest` applies the as-of regime oracle (--no-regime to disable).

HONEST CAVEATS (do not over-claim):
- Profitable period concentrated in recent ~90d; older months idle/small loss
  — not yet a full bear-regime test.
- Tuning (width cap 1.012, regime min_ratio 0.6) informed by recent data →
  90d PASS is partly in-sample to those choices.
- SOL/USDC (biggest contributor) is new (~2mo), emissions swing 524%→5755%.
- 6h step is coarse (may understate intra-step divergence).
- **The CODE gate reads the PAPER ledger (still 0/8), NOT the backtest.** The
  backtest PASS is strong evidence; the live gate still requires paper entries.
NEXT: let paper ledger fill; consider finer-step confirm; optionally test the
truly-old regime (need pools that existed then). Archive key in .env on this
machine only — add to VPS .env to enable deep backtests there.

## REGIME GATE BUILT & LIVE (2026-06-13 night)
Turned the regime finding into an automated gate (commit). `src/scoring/regime.ts`
+ config.regime {enabled, baseline_lookback_days 150, min_ratio 0.6,
max_staleness_hours 48}. Rule: deploy a pool only if its current emission APY
>= 0.6x its own trailing-150d DefiLlama median; else STAND DOWN. Wired into
viableScores (optional predicate) → enforced in BOTH paper monitor and live
cycle (real money only deploys in favorable regimes). Baseline cached to
data/regime-baseline.json, auto-refreshes when stale. Fails OPEN on
missing/stale/unmapped data (it's an enhancement, not a safety gate). Velodrome
config has it disabled (UUIDs Base-only). `npm run regime` shows current
decision + month-by-month no-lookahead validation. Validated: deploys in high
months, stands down in documented low-carry months (~9/12 for blue chips); all
4 pools favorable NOW (ratios 1.5-3.3) so current profitable behavior preserved.
Dashboard+paper restarted on this code. NEXT (still): archive RPC key →
granular multi-month net-alpha backtest; let clean paper ledger fill.

## REGIME DATA (2026-06-13 night) — 11 MONTHS via DefiLlama (`npm run regime`)
Granular state months back is blocked (tested 13 public RPCs — ALL prune state;
needs a keyed archive endpoint). But DefiLlama yields gives ~11 months of daily
headline APY (base=fees / reward=emissions) + TVL per pool, no key. Verdict:
**the recent backtest profit is REGIME-FAVORABLE, not steady-state.** Current
emissions sit ABOVE each pool's 11-month median:
  WETH/USDC   now ~24% vs median 12%  (persistence 0.49)
  USDC/cbBTC  now ~26% vs median ~12% (persistence ~0.5)
  WETH/cbBTC  now ~11% vs median  8%  (persistence 0.69)
  SOL/USDC    now 3777% vs median 1148% (persistence 0.30)  ← the pocket; tiny
              ($228k TVL), new (61d), emissions swing 524%→5755% month to month.
Emission carry has been LOW for long stretches (e.g. WETH/cbBTC 3-9% most of
2026) → in those months the strategy would lose (divergence > carry). So:
- The June-2026 profitable window is an emission spike; do NOT extrapolate it.
- Within the 14d dense backtest the over-prediction is eta/share (not rate
  decay — gauge rate is ~stable intra-window); the persistence signal is a
  MONTHS-scale risk caveat, not a within-window fix. Did NOT bolt an
  unvalidatable persistence multiplier onto the live scorer.
TO UNLOCK granular multi-month net-alpha validation: add ONE keyed archive RPC
(Alchemy/QuickNode/Chainstack free tier) to chain.rpc_urls, then
`npm run residuals` / `backtest --days 180`. That is the real next step.

## QUANT PASS (2026-06-13 eve) — residual analysis + 2 evidence-based fixes
Built `npm run` script src/sim/residuals.ts: term-by-term predicted-vs-realized
decomposition across MULTIPLE no-lookahead windows. Findings:
- **Data cliff:** history_samples thin ~15x beyond ~14d ago (week3/4 ≈ 1.2k
  samples vs ~20k recent). Only the recent ~14d is faithfully simulatable;
  older "losses" were RPC-gap artifacts, NOT regime proof.
- **On trustworthy (dense) data the strategy IS profitable:** recent 7d
  windows +$106 (72% sign) and +$77 (67% sign); contiguous 14d nets +$163
  (~300% APR). 2 of 3 dense windows positive.
- **Dominant error = emission capture over-predicted ~2x** (yield bias ~0.5,
  stable across every window/bucket).
- **Losses concentrate in WIDE bands (>1.2%)**: negative realized alpha,
  capture over-predicted ~4x. Tight (<=0.6%) bands earn +$90-105, well
  calibrated. Mechanism: wide bands dilute emission share, just carry beta.
- **Per-trade corr(predicted net, realized alpha) ≈ 0.2** — thin carry
  swamped by divergence noise; ranking power is weak.
- **THE conflict:** profitable config (conf_emissions 0.7) FAILS gate
  (ratio −1.85, over-predicts); gate-friendly config (conf 0.4) LOSES money.
  Gate measures CALIBRATION; profit comes from directional pool selection.
Kept (principled): width_grid.max_mult 2.0→1.012 (cut losing wide-band tail).
Rejected by data (opt-in, default off): empirical in-range eta (EMP_ETA env —
better calibration, worse profit/ranking); flat emission haircut (fixed ratio,
lost money). Both documented in commit. NOT cleared for live.

## BACKTEST VERDICT (2026-06-13, fixed code, 30d real history)
Replaying the corrected model over ~29 days of real Base history:
**net +$74 on $1,500 (~62% APR) BUT validation FAILS — sign agreement 60%
(need 70%), mean alpha/predicted ratio −0.87 (need 0.4–2.5).** Translation:
the small profit is market BETA, not predictable edge. The model's predicted
net is ANTI-correlated with realized alpha — its favorite picks (tight,
high-emission bands) are systematically the ones that realize divergence
losses. Removing the eta-discount on LVR (commit) nudged it (58→60%,
−1.40→−0.87) but did NOT cross into positive territory. This is structural,
not a tuning miss: realized alpha is dominated by price PATH (did the tight
band hold?), which a zero-drift expected-value model can't predict per-entry.
Real path to profitability = better in-range/divergence model calibrated
against MULTIPLE history windows (out-of-sample, not this one 30d window), or
accept it's a beta play (= gambling, not a yield edge). Either way: NOT READY.

## The one number that gates everything
**Validation: 0 of 8 paper trades (clean restart after the accounting fix,
2026-06-12 ~21:20 UTC); backtest gate also FAILS (above). REAL MONEY IS
LOCKED — correctly.**
The `live` command + dashboard enforce this in code. Do NOT weaken the gate;
let the clean ledger accumulate. With 2h min-hold now enforced everywhere,
expect ~1–3 entries/day, so the 8-entry minimum lands in roughly 3–7 days.

## Most likely next work (in value order)
1. **Watch the clean ledger fill.** Local paper restarted on fixed code
   (dashboard PID via `npm run dashboard`, AUTO_START_PAPER=1). When 8+
   entries exist, check the honest accuracy number before anything else.
2. **Update the VPS** (it still runs pre-fix code and its ledger has the
   same corruption): hPanel web terminal → `cd yield-bot && git pull &&
   docker compose -f docker-compose.paper.yml up -d --build`, then quarantine
   its paper_entries the same way (see paper_entries_quarantined locally).
3. Auto-tuning loop: use ledger outcomes to adjust fee_persistence /
   vol floors / entry bar automatically.
4. Velodrome paper loop on the VPS too (second container with
   `--config config.velodrome.yaml`).
5. When gate passes → GO-LIVE.md runbook ($200–500 first).
6. treefi.xyz TLS still unresolved (cert never issued; suspect empty
   DASH_DOMAIN in /root/yield-bot/.env — verify with `cat .env` on VPS).

## Hard-won lessons (do not relearn these)
- `.gitignore` dir patterns without leading slash match at EVERY depth —
  `data/` excluded `src/data/` and broke the cloud build for hours.
- Killed gauges report stale rewardRate forever; liveness = periodFinish.
- Emission + fee yields are mutually exclusive on Aerodrome (max, not sum).
- Headline APR ≈ concentration projection; real net is 10–100× lower.
- Position size has an interior optimum on thin pools ($400 won; $5k lost).
- The paper ledger is sacred — never let test/fabricated rows into
  paper_entries.

## Key files
- `config.yaml` (Aerodrome) / `config.velodrome.yaml` — every tunable
- `src/scoring/optimizer.ts` — the brain (size × width × cadence-aware NEY)
- `src/sim/backtest.ts` — no-lookahead replay; experiment opts (forceEntry/
  forcePool/forceWidthMult/forceRebalance)
- `src/server/index.ts` + `web/` — dashboard (localhost-only by design)
- npm scripts: scan, score, backtest, monitor, paper-open/close, live,
  dashboard, discover, capital-test, cadence-sweep, strategy-table
