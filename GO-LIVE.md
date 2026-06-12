# Go-Live Runbook — flipping from paper to real money

Read this the day you're considering real money. It is deliberately blunt.

## The one gate that decides everything

Open the dashboard. Look at the banner. It says one of two things:

- 🔒 **"Proving the strategy on practice money first…"** → **STOP.** Real money
  is not justified yet. The bot will also refuse to start live — by design.
- ✅ **"Validated. The strategy proved itself…"** → the strategy has cleared
  all three checks and live trading is permitted.

The three checks behind that banner (visible under **Advanced → Model validation**):

| Check | Needs | Plain meaning |
|---|---|---|
| Test trades done | ≥ 8 | Enough real paper round-trips to mean something |
| Predictions matched reality | ≥ 70% | When the bot said "profit," profit actually happened |
| Returns realistic | 0.4×–2.5× | It didn't wildly over- or under-promise |

**Do not go live on APR numbers. Go live on this banner turning green.** APR cards
are projections; this banner is the verdict of real (paper) outcomes.

## When it's green — the steps (about 20 minutes)

### 1. Make a dedicated wallet (never your main wallet)
- Create a fresh wallet (MetaMask, Rabby, etc.) used ONLY by the bot.
- Fund it with **only what you'll trade** + ~$10 of ETH on Base for gas.
- Start small the first time: **$200–500**, not the full plan. Prove the
  live plumbing with money you can shrug off.

### 2. Put the key on the server (never in any file, never in chat)
On the server, the key goes in an environment variable the bot reads at runtime:
```bash
# on the droplet, NOT committed anywhere:
export BOT_PRIVATE_KEY=0xyour_dedicated_wallet_key
export BOT_ADDRESS=0xyour_dedicated_wallet_address
```
For the Docker deployment, put these in a `.env` file next to the compose file
(it's git-ignored) and reference them — never bake a key into the image.

### 3. Switch the bot to live mode
Edit `config.yaml` on the server: change `mode: paper` to `mode: live`.
Leave everything else. The conservative settings stay.

### 4. Turn on alerts (so you see every trade)
Set up a Telegram bot (BotFather → token; your chat id), then in `config.yaml`:
```yaml
alerts:
  telegram:
    enabled: true
```
and export `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. Now every live action,
exit, and any halt pings your phone.

### 5. Start it
- **From the dashboard:** the master button now reads "Start auto-trading" and,
  because mode is live, asks you to confirm REAL-money trading (one click, red
  button — nothing typed). It deploys the validated strategies and manages them.
- **Or from the terminal:** `npm run live -- --live`

Either way the bot STILL re-checks: mode is live ✓, validation gate passed ✓,
key present ✓, contracts verified on-chain ✓. If any fails, it refuses and tells
you which. That's four independent safety locks between you and a bad trade.

## What "live" actually does (so nothing surprises you)

- Deploys into the same pools the dashboard shows as TOP PICK / ready, at the
  optimizer's chosen amounts, up to your `max_positions` (default 3).
- Rebalances only when its gates say it's worth it; exits a pool when it stops
  being profitable; rotates to a better pool when one clearly beats the current.
- Every capital move is crash-safe and resumable; on restart it reconciles
  against the chain so it can never lose track of where your money is.
- It will sit in cash when nothing clears the bar. Cash is a position.

## First-week live discipline

1. Watch the Telegram alerts. Confirm the first deploy, first rebalance, first
   exit each look sane.
2. Compare realized results to what the dashboard predicted. They should track.
   If realized badly lags predicted for a week → pause, tell me, we recalibrate.
3. Only scale up capital after a clean week. The strategy's edge is small and
   anti-scales past a few thousand dollars per pocket — bigger is not better.

## If something looks wrong

- **A 🚨 HALT alert:** don't panic-act. The bot left your capital in a known,
  recoverable state and stopped. Re-run `live` to resume, or look at the
  `exec_actions` table. Nothing is lost; it's paused on purpose.
- **Losses mounting:** hit Pause (dashboard) or `Ctrl-C` the live process. Open
  positions stay on-chain in your wallet; you can close them from the dashboard.
- **Anything you don't understand:** stop first, ask second. Paused costs you
  nothing. A misunderstood live bot can.

## The honest expectation

While a genuine pocket exists and conditions are calm, the realistic take is
**tens of dollars per week per ~$400–1,000 pocket** — real, but small, and it
shrinks as others copy it. This is a "harvest mispriced incentives carefully"
machine, not a money printer. The safety rails exist because the downside of
getting it wrong (LVR bleed, a depeg, a bad contract) is far larger than the
upside of any single week. Protect the capital first; the yield is the bonus.
