# Project Status — read me first in any new session

_Last updated: 2026-06-12 (evening — accounting-bug fix sprint). This file is
the single source of truth for "where are we" — update it whenever something
material changes._

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
The 13 pre-fix ledger rows were measured with a broken ruler → moved to
`paper_entries_quarantined` (audit trail kept). Ledger restarts at 0/8.

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

## The one number that gates everything
**Validation: 0 of 8 paper trades (clean restart after the accounting fix,
2026-06-12 ~21:20 UTC). REAL MONEY IS LOCKED — correctly.**
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
