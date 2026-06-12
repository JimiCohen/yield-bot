import type { Store } from "../data/store.js";
import type { AuditLog } from "../audit/log.js";

/**
 * Idempotent, resumable execution state machine — Phase 8.
 *
 * Every capital movement is an Action made of ordered Steps. Each step
 * implements:
 *   - alreadyDone(ctx): re-check ON-CHAIN whether this step's effect already
 *     exists. This is the idempotency core: after a crash, resume re-runs
 *     the checks, never the side effects.
 *   - execute(ctx): perform the side effect (send tx, wait for receipt) and
 *     return updated context (e.g. minted tokenId).
 *
 * Context is JSON-persisted to SQLite after EVERY transition, so the
 * process can die at any point and the next start resumes exactly where the
 * chain says it is. The invariant this buys: the bot can never lose track
 * of where capital sits — the chain is canonical, the DB is a resume hint.
 *
 * A step that fails after retries HALTS the action (status 'halted') and
 * alerts; halted actions block all new actions until resolved (resumed or
 * manually reconciled). Halting beats guessing.
 */

export interface StepDef<C> {
  name: string;
  alreadyDone: (ctx: C) => Promise<boolean>;
  execute: (ctx: C) => Promise<C>;
}

export interface ActionRecord {
  id: number;
  kind: string;
  status: "pending" | "running" | "done" | "halted";
  currentStep: number;
  context: unknown;
}

export class ExecutionMachine {
  constructor(
    private store: Store,
    private audit: AuditLog,
    private log: (m: string) => void,
  ) {}

  /** Create a new persisted action. Refuses while any action is halted. */
  begin(kind: string, context: unknown): number {
    const halted = this.store.getActionsByStatus("halted");
    if (halted.length > 0) {
      throw new Error(
        `Refusing new ${kind}: action #${halted[0]!.id} (${halted[0]!.kind}) is HALTED and must be resolved first.`,
      );
    }
    const id = this.store.insertAction(kind, context);
    this.audit.record("exec_action", kind, "BEGIN", { actionId: id });
    return id;
  }

  /** Run (or resume) one action to completion or halt. */
  async run<C>(id: number, steps: StepDef<C>[]): Promise<"done" | "halted"> {
    const rec = this.store.getAction(id);
    if (!rec) throw new Error(`action ${id} not found`);
    if (rec.status === "done") return "done";
    let ctx = rec.context as C;
    this.store.setActionStatus(id, "running", rec.currentStep);

    for (let i = rec.currentStep; i < steps.length; i++) {
      const step = steps[i]!;
      try {
        const done = await step.alreadyDone(ctx);
        if (done) {
          this.log(`  step ${i + 1}/${steps.length} ${step.name}: already done (idempotent skip)`);
          this.store.recordStep(id, i, step.name, "skipped", null, null);
        } else {
          this.log(`  step ${i + 1}/${steps.length} ${step.name}: executing`);
          ctx = await step.execute(ctx);
          this.store.recordStep(id, i, step.name, "done", null, null);
        }
        this.store.setActionStatus(id, "running", i + 1, ctx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.store.recordStep(id, i, step.name, "failed", null, msg);
        this.store.setActionStatus(id, "halted", i, ctx);
        this.audit.record("exec_action", rec.kind, "HALTED", {
          actionId: id,
          step: step.name,
          error: msg.slice(0, 500),
        });
        return "halted";
      }
    }
    this.store.setActionStatus(id, "done", steps.length, ctx);
    this.audit.record("exec_action", rec.kind, "DONE", { actionId: id });
    return "done";
  }

  /** Actions interrupted by a crash (pending/running) or halted earlier. */
  unfinished(): ActionRecord[] {
    return [
      ...this.store.getActionsByStatus("running"),
      ...this.store.getActionsByStatus("pending"),
      ...this.store.getActionsByStatus("halted"),
    ];
  }
}
