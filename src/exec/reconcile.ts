import type { ChainClient } from "../chain/client.js";
import type { Config } from "../config/schema.js";
import type { Store } from "../data/store.js";
import type { AuditLog } from "../audit/log.js";
import type { Alerts } from "../alerts/telegram.js";
import { fetchOnchainPositions } from "../monitor/positions.js";
import { erc20WriteAbi } from "../chain/abis.js";
import type { PoolSnapshot } from "../types.js";

/**
 * Startup reconciliation — Phase 8. Runs BEFORE any new decision, every
 * start. Answers one question from chain truth: where is the capital?
 *
 *  1. Unfinished machine actions (crash mid-move) are surfaced for resume —
 *     capital mid-flight is found by re-running idempotency checks.
 *  2. On-chain positions are diffed against live_positions:
 *     - on chain but not in DB  => ADOPTED into the DB (capital is never
 *       ignored just because our record of it was lost) + alert
 *     - in DB but not on chain  => marked closed + alert (someone moved it
 *       outside the bot, or a record outlived its position)
 *  3. Wallet balances are reported so idle capital is visible.
 */

export interface ReconcileReport {
  unfinishedActions: number;
  adopted: string[];
  phantoms: string[];
  usdcBalance: number;
  positionsOnchain: number;
}

export async function reconcile(
  cfg: Config,
  client: ChainClient,
  store: Store,
  audit: AuditLog,
  alerts: Alerts,
  owner: `0x${string}`,
  snapshots: PoolSnapshot[],
): Promise<ReconcileReport> {
  const unfinished = [
    ...store.getActionsByStatus("running"),
    ...store.getActionsByStatus("pending"),
    ...store.getActionsByStatus("halted"),
  ];
  if (unfinished.length > 0) {
    await alerts.critical(
      `Reconcile: ${unfinished.length} unfinished execution action(s) found ` +
        `(${unfinished.map((a) => `#${a.id} ${a.kind}/${a.status}`).join(", ")}) — resuming before anything else.`,
    );
  }

  const onchain = await fetchOnchainPositions(client, owner, snapshots);
  const dbOpen = store.getOpenLivePositions();
  const onchainIds = new Set(onchain.map((p) => p.tokenId.toString()));
  const dbIds = new Set(dbOpen.map((p) => p.tokenId));

  const adopted: string[] = [];
  for (const p of onchain) {
    const id = p.tokenId.toString();
    if (!dbIds.has(id)) {
      store.upsertLivePosition(
        id,
        p.pool ?? "unknown",
        p.pair ?? "unknown",
        p.staked ? "emissions_staked" : "fees_unstaked",
      );
      adopted.push(id);
    }
  }
  const phantoms: string[] = [];
  for (const p of dbOpen) {
    if (!onchainIds.has(p.tokenId)) {
      store.closeLivePosition(p.tokenId);
      phantoms.push(p.tokenId);
    }
  }
  if (adopted.length > 0) {
    await alerts.critical(
      `Reconcile: adopted ${adopted.length} on-chain position(s) missing from DB: ${adopted.join(", ")}`,
    );
  }
  if (phantoms.length > 0) {
    await alerts.critical(
      `Reconcile: ${phantoms.length} DB position(s) no longer exist on-chain (marked closed): ${phantoms.join(", ")}`,
    );
  }

  const usdc = cfg.allowlist.tokens["USDC"]!;
  const usdcRaw = (await client.readContract({
    address: usdc.address as `0x${string}`,
    abi: erc20WriteAbi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  const usdcBalance = Number(usdcRaw) / 10 ** usdc.decimals;

  const report: ReconcileReport = {
    unfinishedActions: unfinished.length,
    adopted,
    phantoms,
    usdcBalance,
    positionsOnchain: onchain.length,
  };
  audit.record("reconcile", owner, "DONE", report as unknown as Record<string, unknown>);
  return report;
}
