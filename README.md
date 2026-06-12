# Aerodrome Yield Bot

Automated yield allocation for blue-chip concentrated-liquidity pools on
Aerodrome Slipstream (Base). Optimizes **realized, net-of-everything USDC
returns** — not headline APR.

> **Status: all 9 phases built.** Scanner, NEY scoring, backtest/validation,
> monitoring, gated rebalancing, switching, risk triggers, execution layer
> (idempotent state machine + reconciliation + signer), alerts.
> **Default mode is `paper`. The `live` command refuses to run until the
> paper predicted-vs-realized ledger passes the validation gate** — this is
> enforced in code (`execution.*` in config), not just in documentation.
>
> **Phase gate status: model validation has NOT passed yet** (0 qualifying
> ledger entries; the conservative gates have correctly kept the bot in
> cash through a falling market). Run `npm run monitor -- --watch` to
> accumulate paper entries. See [docs/MODELS.md](docs/MODELS.md) §5 and the
> go-live runbook below.

## Design principles

1. **Single numéraire.** Every yield and cost component — fees, emissions,
   IL/LVR, gas, slippage — is converted to USDC before any comparison.
2. **On-chain canonical.** Execution-relevant data (pool state, TVL, gauge
   status, reward rates) comes from Base RPC directly. DeFiLlama is used for
   discovery hints and APY sanity cross-checks only, never for sizing.
3. **Emissions are low-confidence yield.** On Aerodrome, gauge-staked CL
   positions earn AERO **instead of** swap fees (fees go to veAERO voters).
   AERO yield is valued at realizable price with a haircut and decay
   assumption, and confidence-weighted below fee yield.
4. **Anti-over-rebalancing.** Dead-band + net-benefit-with-margin + rate
   limit. Over-rebalancing is the default failure mode of CL bots.
5. **Capital can never be lost track of.** All multi-step actions are
   persisted, idempotent state machines; startup always reconciles DB state
   against the chain (Phase 8).

## Architecture

```
src/
├── config/     zod-validated YAML config; all tunables live in config.yaml
├── chain/      viem client (RPC failover), Aerodrome addresses, minimal ABIs
├── data/
│   ├── scanner.ts   deterministic pool discovery (factory probes per
│   │                allowlisted pair x tick spacing) + hard filters
│   ├── llama.ts     DeFiLlama advisory (discovery/sanity ONLY, soft-fail)
│   └── store.ts     SQLite: scan history, pool snapshots, decision records
├── audit/      structured decision log (SQLite + JSONL) — every ELIGIBLE,
│               REJECTED, and later every rebalance/skip records its WHY
├── types.ts    PoolSnapshot and shared types
└── cli/        entry point (`scan`, later `score`, `backtest`, `paper`, `live`)
```

### Hard filters (Phase 1)

A pool is eligible only if **all** pass:

- Both tokens on the configured asset allowlist (WETH, USDC, cbBTC —
  cbBTC over WBTC: canonical, Coinbase-custodied, deepest BTC on Base).
- On-chain TVL > `filters.min_tvl_usdc` (default $100k), valued via on-chain
  prices from the deepest token/USDC pool.
- Gauge exists and `Voter.isAlive(gauge)` is true — a missing/killed gauge is
  the on-chain marker for deprecated or migrating pools.

## Setup & usage

```bash
cd aerodrome-yield-bot
npm install
npm run scan          # on-chain scan + hard filters, persists snapshots
npm run score         # scan + Net Expected Yield scoring + width optimizer
npm run backtest      # no-lookahead historical replay + model validation
npm run paper-open    # open a paper position from the current top score
npm run monitor       # check positions: in-range, accruals, deadband state
npm run paper-close   # close a paper position, write the realized ledger entry
npm run live -- --live  # LIVE execution (refuses until the validation gate passes)
npm run dashboard     # web dashboard: http://127.0.0.1:8787
```

### Dashboard

`npm run dashboard` serves a local web UI (default `127.0.0.1:8787`) that
visualizes and controls everything:

- **Controls** — start/pause paper trading, run/stop backtests (with window
  length), and start/stop live trading (requires typing `LIVE` + a browser
  confirm — and the bot process itself still enforces config `mode: live`,
  the validation gate, the key, and router verification; the dashboard
  cannot bypass what the CLI refuses, because it only spawns the CLI).
- **Validation gate** — live progress toward the three go-live thresholds.
- **Pool scores** — latest NEY decomposition per pool + 7-day APR history
  chart (the watch loop persists scores every cycle).
- **Positions** — open paper positions with in-range state, accruals,
  uPnL, and a close button; live positions and execution actions.
- **Backtests, realized ledger, decision audit trail, streaming logs** for
  each task (SSE).

**Security: the dashboard can start live trading.** It has **no in-app
login by design** — it binds localhost only and refuses any other bind.
Local use is never locked. Remote/cloud access goes through authenticated
infrastructure in front of it (Caddy basic-auth + HTTPS, or Tailscale) —
see [DEPLOY.md](DEPLOY.md) for the Docker compose kit and full runbook.

**Desktop launcher:** `Aerodrome Dashboard.app` (created on the Desktop;
also `Aerodrome Dashboard.command` in this folder) starts the server if
needed, starts the paper loop, and opens the dashboard in your browser.

### Paper trading & monitoring (Phase 4)

`paper-open` takes the live allocation suggestion (refusing when nothing
clears `min_net_yield_apr` — staying out is a position too) and opens a
shadow position with real entry costs charged. `monitor` (add `--watch` for
a jittered loop at `check_interval_minutes`) marks it against REAL on-chain
deltas — actual feeGrowthGlobal growth, actual gauge rewardRate gated by
periodFinish, actual AERO price — and persists out-of-range / beyond-deadband
timestamps to `range_state` (crash-safe hysteresis input for Phase 5).
`paper-close` realizes the position and writes a predicted-vs-realized
ledger entry: paper entries accumulate the validation data the phase gate
requires. With `BOT_ADDRESS` set, `monitor` also enumerates real wallet and
gauge-staked Slipstream NFTs (read-only; no key material).

### Gated rebalancing (Phase 5)

Each `monitor` check runs the rebalance decision stack on every open
position. A rebalance fires only when ALL gates pass, in order: (1) price
beyond the deadband-extended band, sustained `sustain_minutes` on the
persisted `range_state` clock; (2) the pool still clears
`min_net_yield_apr` on a fresh score — otherwise the action is EXIT, not
rebalance; (3) per-position rate limit from `rebalance_events` history;
(4) projected net yield ≥ `net_benefit_margin` × full move cost. On a pass,
the position recenters at the current tick with a freshly optimized width.
Every blocked attempt is audit-logged with the blocking gate — that record
is how thresholds get re-tuned from data. Paper positions execute
automatically; live execution arrives in Phase 8 behind the same gates.

`score` gathers, per eligible pool: empirical fee rate (feeGrowthGlobal
deltas over a 24h→6h→1h window ladder), realized volatility (pool oracle →
historical slot0 → locally accumulated samples → config fallback), realizable
AERO valuation from the deepest AERO/USDC pool on-chain, live gas pricing —
then runs the fees-vs-LVR width optimizer over both yield arms and prints the
full cost decomposition (gross, LVR, rebalance churn, entry/exit) with an
allocation suggestion. Every score is persisted as the "predicted" side of
the predicted-vs-realized ledger that Phase 3 validates.

Output artifacts:

- `data/bot.db` — SQLite: `scans`, `pool_snapshots` (historical, feeds the
  Phase 3 backtester and predicted-vs-realized ledger), `decisions`.
- `logs/decisions.jsonl` — append-only audit trail.

### Configuration

Everything tunable is in [config.yaml](config.yaml), commented inline:
capital, allowlist, hard filters, scoring confidences/haircuts, position
sizing (incl. the `min_position_usd` floor that overrides the 40% per-pool
cap at test scale), rebalance gates, slippage caps, compound threshold, risk
triggers, alerting.

**Secrets are never stored in files.** The config references env var *names*
only (`BOT_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`, …). Use a dedicated wallet
funded only with managed capital.

### RPC note

Default endpoints are public and rate-limited; fine for scanning. Phase 3
backtesting requires historical log queries — configure an archive-grade
endpoint in `chain.rpc_urls` before then.

## Models

The Net Expected Yield formula, emission valuation method, fees-vs-LVR range
strategy, and anti-over-rebalancing logic are documented in
[docs/MODELS.md](docs/MODELS.md). Read it before changing any scoring config.

## Cross-pool switching (Phase 6)

Held positions are compared against the best viable alternative every
check. A switch pays the FULL round trip (exit gas + swap out + entry gas +
swap in, all size-aware) and fires only when the NEY advantage exceeds
`switch_margin` (default 4×, stricter than rebalancing) times that cost.

## Risk triggers (Phase 7)

Any tripped trigger exits NOW, bypassing all gates: USDC depeg and cbBTC/BTC
basis (from DeFiLlama's price API — a deliberate exception to on-chain
canonical, because detecting a USDC depeg from pools priced in USDC is
circular), TVL collapse vs the trailing snapshot peak, and vol spikes above
`vol_spike_multiple` × the config prior. A dead advisory source degrades to
"no signal," reported as such — it never blocks operation.

## Execution layer (Phase 8)

Every live capital movement is a persisted, **idempotent, resumable state
machine** (`exec_actions`/`exec_steps` in SQLite). Each step re-checks the
CHAIN for whether its effect already exists before executing — after a
crash, resume re-runs checks, never side effects. A failed step HALTS the
action, alerts, and blocks all new actions until resolved. Startup always
runs **reconciliation**: on-chain positions are diffed against the DB
(orphans adopted, phantoms closed, both alerted), unfinished actions are
resumed first, and wallet balances reported. The chain is canonical; the DB
is a resume hint. The bot cannot lose track of capital.

Submission policy: strict `minOut`/`amountMin` bounds from the config
slippage caps on every swap and liquidity action, short deadlines, bounded
backoff (idempotency checks make retries safe), timing jitter on the loop.
Base has no public mempool (sequencer-private), so these — not a relay —
are the defenses that matter; the submission path is pluggable if that
changes. The SwapRouter address is verified on-chain at startup
(`factory()` must match the Slipstream factory) before any approval.

### Go-live runbook

1. `npm run monitor -- --watch` (paper) until the ledger passes the gate:
   ≥ `validation_min_entries` paper round-trips, sign agreement ≥ 70%,
   alpha/predicted ratio in [0.4, 2.5]. Check progress anytime — the `live`
   command prints exactly what's missing.
2. Create a **dedicated wallet**, fund with managed capital only
   (+ a little ETH for gas). `export BOT_PRIVATE_KEY=...` (never in files).
3. Enable Telegram alerts (`alerts.telegram.enabled: true`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
4. Set `mode: live` in config.yaml AND pass `--live`: `npm run live -- --live`.
5. First runs at minimum size. Watch the alerts channel: every execution,
   halt, and reconcile anomaly reports there.

**Honest disclosure:** the execution builders are typechecked against real
ABIs, the machine's crash-resume semantics are tested, the router is
verified on-chain, and the full live path has been dry-exercised with an
empty wallet — but no funded wallet has executed these transactions yet.
That is one more reason the validation gate and minimum-size first runs are
not optional.

## Honesty notes / known limitations

- Modeled yield is an estimate, not a promise. Emission-driven yield (most
  of Aerodrome's yield) is explicitly low-confidence: AERO price risk between
  harvests is real and the haircut/decay parameters are assumptions until
  validated by the Phase 3 backtest.
- Scanner TVL uses raw pool token balances (slightly overcounts by uncollected
  fees) and double-precision pricing — fine for filtering, never used for
  execution math.
- The gauge mechanics assumption (staked = AERO instead of fees) is verified
  against pool `stakedLiquidity` reads, but exact fee forfeiture behavior will
  be re-verified against the deployed CLGauge before any live execution.
