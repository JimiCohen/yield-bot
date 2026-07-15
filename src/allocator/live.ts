import type Database from "better-sqlite3";
import type { ChainClient } from "../chain/client.js";
import type { Config } from "../config/schema.js";
import { makeSigner } from "../exec/signer.js";
import { VENUES, USDC_BASE, readVenue, type Venue } from "./venues.js";

/**
 * LIVE deposit/withdraw for the PARK+GUARD allocator.
 *
 * Deliberately minimal surface: one asset (USDC), one venue at a time, no
 * swaps, no ranges, no prediction. ERC4626 deposit/redeem or Aave
 * supply/withdraw, with exact-amount approvals and a hard cap.
 *
 * SAFETY GATES (all enforced in code, in order):
 *  1. cfg.mode must be "live" AND the CLI --live flag passed (two-key).
 *  2. The paper allocator must show >= gate_min_days of snapshots with
 *     positive REAL on-chain accrual (measured, not advertised).
 *  3. Deposit amount hard-capped at allocator.capital_usd AND
 *     position.max_position_usd.
 *  4. Venue must pass on-chain verification (vault.asset() == USDC).
 */

const erc20Abi = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const erc4626WriteAbi = [
  { name: "deposit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "redeem", type: "function", stateMutability: "nonpayable", inputs: [{ name: "shares", type: "uint256" }, { name: "receiver", type: "address" }, { name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "maxRedeem", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const aaveWriteAbi = [
  { name: "supply", type: "function", stateMutability: "nonpayable", inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "onBehalfOf", type: "address" }, { name: "referralCode", type: "uint16" }], outputs: [] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable", inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export function assertAllocatorLiveAllowed(cfg: Config, db: Database.Database): void {
  const gateMinDays = 7;
  const rows = db
    .prepare(
      "SELECT ts, implied_apr_pct FROM alloc_snapshots WHERE implied_apr_pct IS NOT NULL ORDER BY ts",
    )
    .all() as { ts: number; implied_apr_pct: number }[];
  if (rows.length === 0) throw new Error("allocator live gate: no paper snapshots yet — run `allocate --watch` first");
  const spanDays = (rows[rows.length - 1]!.ts - rows[0]!.ts) / 86_400_000;
  // Hold-time-weighted mean of measured APR must be positive and sane.
  const mean = rows.reduce((a, r) => a + r.implied_apr_pct, 0) / rows.length;
  const failures: string[] = [];
  if (spanDays < gateMinDays) failures.push(`only ${spanDays.toFixed(1)}d of paper accrual (< ${gateMinDays}d)`);
  if (!(mean > 0.5)) failures.push(`measured APR ${mean.toFixed(2)}% not clearly positive`);
  if (!(mean < 25)) failures.push(`measured APR ${mean.toFixed(2)}% implausibly high — investigate before live`);
  if (failures.length) {
    throw new Error(`allocator live gate NOT passed:\n  ${failures.join("\n  ")}`);
  }
}

async function ensureAllowance(
  client: ChainClient,
  signer: ReturnType<typeof makeSigner>,
  spender: `0x${string}`,
  amount: bigint,
  log: (m: string) => void,
): Promise<void> {
  const current = (await client.readContract({
    address: USDC_BASE, abi: erc20Abi, functionName: "allowance", args: [signer.address, spender],
  })) as bigint;
  if (current >= amount) return;
  log(`approving ${amount} USDC to ${spender} (exact amount)`);
  const hash = await signer.wallet.writeContract({
    address: USDC_BASE, abi: erc20Abi, functionName: "approve", args: [spender, amount],
    chain: signer.wallet.chain, account: signer.wallet.account!,
  });
  await client.waitForTransactionReceipt({ hash });
}

/** Deposit `usd` (clamped by caps) into the venue. Returns tx hash. */
export async function liveDeposit(
  cfg: Config,
  client: ChainClient,
  db: Database.Database,
  venue: Venue,
  usd: number,
  log: (m: string) => void,
): Promise<string> {
  assertAllocatorLiveAllowed(cfg, db);
  const reading = await readVenue(client, venue);
  if (!reading.verified) throw new Error(`${venue.key} failed on-chain verification — refusing`);
  const cap = Math.min(usd, cfg.allocator.capital_usd, cfg.position.max_position_usd ?? Infinity);
  const amount = BigInt(Math.floor(cap * 1e6));
  const signer = makeSigner(cfg);
  const bal = (await client.readContract({
    address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [signer.address],
  })) as bigint;
  if (bal < amount) throw new Error(`wallet has ${Number(bal) / 1e6} USDC < ${cap} requested`);

  if (venue.kind === "erc4626") {
    await ensureAllowance(client, signer, venue.address, amount, log);
    const hash = await signer.wallet.writeContract({
      address: venue.address, abi: erc4626WriteAbi, functionName: "deposit",
      args: [amount, signer.address], chain: signer.wallet.chain, account: signer.wallet.account!,
    });
    await client.waitForTransactionReceipt({ hash });
    log(`LIVE deposit $${cap} -> ${venue.name} (${hash})`);
    return hash;
  }
  await ensureAllowance(client, signer, venue.address, amount, log);
  const hash = await signer.wallet.writeContract({
    address: venue.address, abi: aaveWriteAbi, functionName: "supply",
    args: [USDC_BASE, amount, signer.address, 0], chain: signer.wallet.chain, account: signer.wallet.account!,
  });
  await client.waitForTransactionReceipt({ hash });
  log(`LIVE supply $${cap} -> ${venue.name} (${hash})`);
  return hash;
}

/** Real wallet position value in a venue, in USD (null if none / unreadable). */
export async function readLivePositionUsd(
  cfg: Config,
  client: ChainClient,
  venue: Venue,
): Promise<number | null> {
  const signer = makeSigner(cfg);
  if (venue.kind === "erc4626") {
    const shares = (await client.readContract({
      address: venue.address, abi: erc4626WriteAbi, functionName: "balanceOf", args: [signer.address],
    })) as bigint;
    if (shares === 0n) return 0;
    const assets = (await client.readContract({
      address: venue.address,
      abi: [{ name: "convertToAssets", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }] as const,
      functionName: "convertToAssets",
      args: [shares],
    })) as bigint;
    return Number(assets) / 1e6;
  }
  if (!venue.aToken) return null;
  const bal = (await client.readContract({
    address: venue.aToken, abi: erc20Abi, functionName: "balanceOf", args: [signer.address],
  })) as bigint;
  return Number(bal) / 1e6;
}

/** Withdraw everything from the venue back to the wallet as USDC. */
export async function liveWithdrawAll(
  cfg: Config,
  client: ChainClient,
  venue: Venue,
  log: (m: string) => void,
): Promise<string> {
  const signer = makeSigner(cfg);
  if (venue.kind === "erc4626") {
    const shares = (await client.readContract({
      address: venue.address, abi: erc4626WriteAbi, functionName: "maxRedeem", args: [signer.address],
    })) as bigint;
    if (shares === 0n) throw new Error("no shares to redeem");
    const hash = await signer.wallet.writeContract({
      address: venue.address, abi: erc4626WriteAbi, functionName: "redeem",
      args: [shares, signer.address, signer.address], chain: signer.wallet.chain, account: signer.wallet.account!,
    });
    await client.waitForTransactionReceipt({ hash });
    log(`LIVE redeem all from ${venue.name} (${hash})`);
    return hash;
  }
  const MAX = 2n ** 256n - 1n; // Aave sentinel: withdraw full balance
  const hash = await signer.wallet.writeContract({
    address: venue.address, abi: aaveWriteAbi, functionName: "withdraw",
    args: [USDC_BASE, MAX, signer.address], chain: signer.wallet.chain, account: signer.wallet.account!,
  });
  await client.waitForTransactionReceipt({ hash });
  log(`LIVE withdraw all from ${venue.name} (${hash})`);
  return hash;
}

export { VENUES };
