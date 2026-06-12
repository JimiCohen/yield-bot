# Security — how this bot avoids losing money to anything but the market

## What's enforced in code (verified)

| Risk | Defense |
|---|---|
| Key theft from disk/repo | Private key exists ONLY in `$BOT_PRIVATE_KEY` at runtime; never written, never logged (grep-audited); config files hold env var *names* only |
| Malicious/typo'd contracts | Router AND position manager for BOTH factories verified on-chain at every live startup (`factory()` must match); refusal, not warning, on mismatch |
| Unlimited token approvals | Approvals are exact-amount per action, never infinite |
| Sandwich/slippage | Hard `amountOutMinimum`/`amountMin` from config caps on every swap and liquidity action + short deadlines (Base has no public mempool; these are the defenses that matter there) |
| Half-finished transactions | Every capital movement is an idempotent, resumable state machine; steps re-check the CHAIN before executing; failures HALT and block new actions |
| Lost track of capital | Startup reconciliation diffs on-chain positions vs DB: orphans adopted, phantoms closed, all alerted |
| Migrating/dead pools | Hard filter: gauge must exist, be alive, and have a current `periodFinish` (killed gauges advertise stale reward rates forever) |
| Depegs / vol spikes / TVL collapse | Risk triggers exit immediately, bypassing all other gates; depeg uses an independent price source (checking USDC against pools priced in USDC is circular) |
| Unproven model | The `live` command REFUSES to run until the paper ledger meets the validation thresholds; two-key arming (config `mode: live` + `--live` flag) |
| Dashboard abuse | Binds 127.0.0.1 only, refuses other binds; cloud access only via authenticated proxy (DEPLOY.md); controls spawn the gated CLI, so the UI cannot bypass what the CLI refuses |
| Aggressive paper settings leaking to live | Paper-learning values are flagged in config comments; the validation gate judges their OUTCOMES before live is possible |

## Protocol risk (what code can't fix)

- **Aerodrome contracts**: Velodrome V2 lineage audited by Spearbit (119 findings, all critical/high fixed pre-deploy); Slipstream + later versions audited by multiple firms (11 audits tracked on DeFiScan) with a live $100k bug bounty. Good standing — not zero risk. The per-pool cap and fast-exit posture exist because audits reduce, never remove, contract risk.
- **AERO token risk**: emissions are paid in AERO; its price can gap down between harvests. Mitigations: daily compounding (short exposure window), 15% haircut + decay assumption in scoring.
- **Wrapped-asset trust**: cbBTC (Coinbase custody) and wrapped SOL carry issuer/bridge risk; basis monitors trigger exit on divergence.

## Operator runbook (your part)

1. **Dedicated wallet** for the bot, funded ONLY with managed capital + ~$10 ETH gas. Never your main wallet.
2. Export `BOT_PRIVATE_KEY` in the shell/service environment — never in any file, never in chat, never in config.
3. Enable Telegram alerts before going live; every execution, halt, and anomaly reports there.
4. First live runs at minimum size ($100–200) even after the gate opens.
5. Periodically review approvals at https://revoke.cash (should only show exact-amount, mostly-consumed approvals to the two verified routers/NPMs).
6. If a HALT alert fires: do nothing in a hurry. The machine left capital in a known, recoverable state; rerun `live` to resume, or inspect `exec_actions` in the DB.
7. Back up `data/bot.db` (it's the validation ledger + position records).
