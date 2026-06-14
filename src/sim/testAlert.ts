import "../config/env.js"; // load .env first
import { loadConfig } from "../config/load.js";
import { Alerts } from "../alerts/telegram.js";

/**
 * Verify Telegram alerts end to end. Run after putting TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID in .env: `npm run test-alert`. If both are set and the chat
 * id is correct, a message lands on your phone; otherwise it explains what's
 * missing and falls back to console.
 */
const cfg = loadConfig(process.argv[2] ?? "config.yaml");
const tokenSet = !!process.env[cfg.alerts.telegram.bot_token_env];
const chatSet = !!process.env[cfg.alerts.telegram.chat_id_env];

console.log(`alerts.telegram.enabled: ${cfg.alerts.telegram.enabled}`);
console.log(`${cfg.alerts.telegram.bot_token_env}: ${tokenSet ? "set ✓" : "MISSING ✗"}`);
console.log(`${cfg.alerts.telegram.chat_id_env}: ${chatSet ? "set ✓" : "MISSING ✗"}`);

if (!cfg.alerts.telegram.enabled) console.log("\n→ set alerts.telegram.enabled: true in config.yaml");
if (!tokenSet || !chatSet) {
  console.log("\n→ add to .env (gitignored):");
  console.log(`   ${cfg.alerts.telegram.bot_token_env}=<token from @BotFather>`);
  console.log(`   ${cfg.alerts.telegram.chat_id_env}=<your chat id>`);
  console.log("Then re-run: npm run test-alert");
}

const alerts = new Alerts(cfg);
await alerts.info(
  "✅ Yield Bot test alert — Telegram is wired up. You'll get a 🚨 message when the validation gate turns green and on every live action.",
);
console.log(
  tokenSet && chatSet && cfg.alerts.telegram.enabled
    ? "\nSent. Check your Telegram — if nothing arrived, the chat id or token is wrong."
    : "\n(Console-only fallback — Telegram not fully configured yet.)",
);
