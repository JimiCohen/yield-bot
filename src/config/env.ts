import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal .env loader (no dependency). Import this FIRST in every entry point
 * so secrets/config in a gitignored .env (BASE_ARCHIVE_RPC, TELEGRAM_BOT_TOKEN,
 * TELEGRAM_CHAT_ID, BOT_PRIVATE_KEY, ...) are available without manual exports.
 * Existing process.env values WIN — an explicit export or Docker env overrides
 * the file, never the reverse.
 */
function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();
