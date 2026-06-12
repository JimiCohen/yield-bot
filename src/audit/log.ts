import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "../data/store.js";

/**
 * Decision audit trail. Every allocation, rebalance, switch, skip, and
 * rejection gets a structured entry stating WHY — written both to SQLite
 * (queryable) and JSONL (greppable, survives db corruption). This is how
 * thresholds get tuned later and how we audit the bot's judgment.
 */
export class AuditLog {
  constructor(
    private store: Store,
    private jsonlPath: string,
  ) {
    mkdirSync(dirname(jsonlPath), { recursive: true });
  }

  record(kind: string, subject: string, decision: string, payload: Record<string, unknown>) {
    const entry = { ts: new Date().toISOString(), kind, subject, decision, ...payload };
    appendFileSync(this.jsonlPath, JSON.stringify(entry) + "\n");
    this.store.recordDecision(kind, subject, decision, payload);
  }
}
