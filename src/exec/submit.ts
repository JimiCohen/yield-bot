import type { Config } from "../config/schema.js";

/**
 * Transaction submission policy.
 *
 * Base reality check (stated honestly): Base has no public mempool — txs go
 * to the centralized sequencer, so Ethereum-style mempool sandwiching mostly
 * does not apply. The defenses that DO work here:
 *  - strict amountOutMinimum / amountMin bounds on every swap and liquidity
 *    action (slippage caps from config, enforced in the action builders)
 *  - short deadlines so stale transactions cannot execute at moved prices
 *  - timing jitter on the calling loop (no observable fixed schedule)
 *  - a pluggable submission URL (chain.private_rpc_url) in case Base's MEV
 *    landscape changes and a protected relay becomes worth using
 *
 * Retry policy: bounded exponential backoff on transient failures. NEVER
 * retry blind — the state machine re-checks on-chain state (alreadyDone)
 * before any resend, so a tx that actually landed is never duplicated.
 */

export function deadline(secondsFromNow = 120): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + secondsFromNow);
}

/** amountOutMinimum for a swap quoted at `quotedOut`, per config cap. */
export function minOut(quotedOut: bigint, cfg: Config): bigint {
  return (quotedOut * BigInt(10_000 - cfg.slippage.swap_cap_bps)) / 10_000n;
}

/** amountMin for liquidity actions, per config cap. */
export function minAmount(expected: bigint, cfg: Config): bigint {
  return (expected * BigInt(10_000 - cfg.slippage.liquidity_cap_bps)) / 10_000n;
}

export async function withBackoff<T>(
  label: string,
  attempts: number,
  fn: () => Promise<T>,
  log: (m: string) => void,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = Math.min(30_000, 1000 * 2 ** i) + Math.random() * 500;
      log(`${label}: attempt ${i + 1}/${attempts} failed (${e instanceof Error ? e.message.slice(0, 120) : e}); backing off ${(wait / 1000).toFixed(1)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
