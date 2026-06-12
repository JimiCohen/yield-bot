import type { Config } from "../config/schema.js";

/**
 * Alerts — Phase 9. Telegram is the default channel; tokens come from env
 * (config names the variables only). Policy:
 *  - critical(): risk triggers, reconcile anomalies, halted actions, every
 *    live execution. Sent to Telegram when enabled; always logged.
 *  - info(): notable but non-urgent (paper actions, validation milestones).
 * Alert failures never break the bot — a dead Telegram must not stop a
 * risk exit.
 */
export class Alerts {
  private token: string | undefined;
  private chatId: string | undefined;
  private enabled: boolean;

  constructor(cfg: Config) {
    this.enabled = cfg.alerts.telegram.enabled;
    this.token = process.env[cfg.alerts.telegram.bot_token_env];
    this.chatId = process.env[cfg.alerts.telegram.chat_id_env];
    if (this.enabled && (!this.token || !this.chatId)) {
      console.warn(
        `alerts: telegram enabled but $${cfg.alerts.telegram.bot_token_env} / $${cfg.alerts.telegram.chat_id_env} not set — falling back to console only`,
      );
      this.enabled = false;
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 4000) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      console.warn("alerts: telegram send failed:", e instanceof Error ? e.message : e);
    }
  }

  async critical(msg: string): Promise<void> {
    console.error(`🚨 ${msg}`);
    await this.send(`🚨 ${msg}`);
  }

  async info(msg: string): Promise<void> {
    console.log(`ℹ ${msg}`);
    await this.send(`ℹ ${msg}`);
  }
}
