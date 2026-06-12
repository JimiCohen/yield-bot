# Project Status — read me first in any new session

_Last updated: 2026-06-12. This file is the single source of truth for
"where are we" — update it whenever something material changes._

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
**Validation: 10 paper trades, 20% prediction accuracy (needs 70%),
realized P&L −$3.81 local / +$0.39 cloud. REAL MONEY IS LOCKED — correctly.**
The `live` command + dashboard enforce this in code. Do NOT weaken the gate;
fix the model until the ledger passes.

## Most likely next work (in value order)
1. **Diagnose the 20% accuracy.** The ledger (paper_entries) now has enough
   rows. Prime suspect: predicted NEY on short holds (alpha/7d scaling
   amplifies noise on 1–2h holds — consider min-hold-aware validation or
   longer holds); second suspect: sub-cadence in-range fraction on ts1
   pools (model assumes GBM ~1%, replay measured ~30%).
2. Auto-tuning loop: use ledger outcomes to adjust fee_persistence /
   vol floors / entry bar automatically.
3. Velodrome paper loop on the VPS too (second container with
   `--config config.velodrome.yaml`).
4. When gate passes → GO-LIVE.md runbook ($200–500 first).

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
