# Running in the cloud

The dashboard has **no in-app login by design**: locally it binds
`127.0.0.1` and refuses anything else. In the cloud, authentication is
provided by infrastructure in front of it — never by exposing the process.

## Option A — VPS with HTTPS + basic auth (permanent, ~$5/mo)

1. Provision a small VPS (Hetzner CX22 / DigitalOcean basic, Ubuntu 24.04)
   and point a DNS A-record at it (e.g. `bot.yourdomain.com`).
2. Install Docker: `curl -fsSL https://get.docker.com | sh`
3. Copy this project to the server:
   `rsync -a --exclude node_modules --exclude data --exclude logs ./ user@server:~/aerodrome-yield-bot/`
4. On the server, create `~/aerodrome-yield-bot/.env`:

   ```env
   DASH_DOMAIN=bot.yourdomain.com
   DASH_USER=you
   DASH_PASS_HASH=   # output of: docker run --rm caddy:2 caddy hash-password
   BOT_PRIVATE_KEY=  # only when going live; omit for paper
   TELEGRAM_BOT_TOKEN=
   TELEGRAM_CHAT_ID=
   ```

5. `docker compose up -d --build`
6. Open `https://bot.yourdomain.com` — browser prompts for user/password
   (that's Caddy, with automatic Let's Encrypt HTTPS). Start paper trading
   from the Controls panel.

The dashboard port is never published; only Caddy is reachable. The bot's
database and logs live in named volumes (`bot-data`, `bot-logs`) and
survive container rebuilds.

## Option B — Tailscale (private network, no public exposure at all)

1. Install Tailscale on the laptop/server running the bot and on the
   devices you browse from (`https://tailscale.com/download`).
2. Run the bot normally (`npm run dashboard` — localhost binding).
3. From another device on your tailnet:
   `tailscale serve --bg 8787` on the host machine, then open the
   machine's tailnet URL. Tailscale handles identity; nothing is public.

## Notes

- **Laptop and cloud are alternatives, not mirrors**: the bot's state
  (positions, ledger, history cache) is the SQLite file where it runs. Run
  ONE instance; browse it from anywhere.
- Going live in the cloud still requires every gate: `mode: live` in
  config, the paper-ledger validation gate, `BOT_PRIVATE_KEY` in the
  environment, and the on-chain router verification.
- Back up the `bot-data` volume — it contains the validation ledger.
