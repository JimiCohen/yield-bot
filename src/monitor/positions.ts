import type { ChainClient } from "../chain/client.js";
import { AERODROME, PERIPHERY } from "../chain/addresses.js";
import { clGaugeAbi, positionManagerAbi } from "../chain/abis.js";
import type { PoolSnapshot } from "../types.js";

/**
 * On-chain position reader: enumerates Slipstream NFTs held by the wallet
 * AND NFTs deposited into known gauges (the gauge owns staked NFTs; we map
 * them back via stakedValues). Read-only — needs an address, never a key.
 *
 * Used by monitoring now and by Phase 8 reconciliation later: this is the
 * "where is the capital, according to the chain" primitive.
 */

export interface OnchainPosition {
  tokenId: bigint;
  pool: `0x${string}` | null; // resolved against scanned pools
  pair: string | null;
  token0: `0x${string}`;
  token1: `0x${string}`;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  staked: boolean;
  pendingAero: bigint | null; // staked only
}

export async function fetchOnchainPositions(
  client: ChainClient,
  owner: `0x${string}`,
  snapshots: PoolSnapshot[],
): Promise<OnchainPosition[]> {
  const out: OnchainPosition[] = [];
  // Both factories have their own NFT manager — enumerate each.
  for (const periphery of Object.values(PERIPHERY)) {
    out.push(...(await fetchForNpm(client, owner, snapshots, periphery.positionManager)));
  }
  return out;
}

async function fetchForNpm(
  client: ChainClient,
  owner: `0x${string}`,
  snapshots: PoolSnapshot[],
  npm: `0x${string}`,
): Promise<OnchainPosition[]> {
  // Wallet-held NFTs.
  const balance = (await client.readContract({
    address: npm,
    abi: positionManagerAbi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  const idCalls = Array.from({ length: Number(balance) }, (_, i) => ({
    address: npm,
    abi: positionManagerAbi,
    functionName: "tokenOfOwnerByIndex" as const,
    args: [owner, BigInt(i)] as const,
  }));
  const idResults = idCalls.length
    ? ((await client.multicall({ contracts: idCalls as never, allowFailure: true })) as {
        status: string;
        result?: unknown;
      }[])
    : [];
  const walletIds = idResults
    .filter((r) => r.status === "success")
    .map((r) => r.result as bigint);

  // Gauge-staked NFTs across all alive gauges from the scan.
  const gauges = [
    ...new Set(
      snapshots.filter((s) => s.gauge && s.gaugeAlive).map((s) => s.gauge as `0x${string}`),
    ),
  ];
  const stakedCalls = gauges.map((g) => ({
    address: g,
    abi: clGaugeAbi,
    functionName: "stakedValues" as const,
    args: [owner] as const,
  }));
  const stakedResults = stakedCalls.length
    ? ((await client.multicall({ contracts: stakedCalls as never, allowFailure: true })) as {
        status: string;
        result?: unknown;
      }[])
    : [];
  const stakedByGauge: { gauge: `0x${string}`; ids: bigint[] }[] = [];
  stakedResults.forEach((r, i) => {
    if (r.status === "success" && Array.isArray(r.result) && r.result.length > 0) {
      stakedByGauge.push({ gauge: gauges[i]!, ids: r.result as bigint[] });
    }
  });

  // Position details + pending AERO for staked ones.
  const allIds: { tokenId: bigint; staked: boolean; gauge: `0x${string}` | null }[] = [
    ...walletIds.map((tokenId) => ({ tokenId, staked: false, gauge: null })),
    ...stakedByGauge.flatMap(({ gauge, ids }) =>
      ids.map((tokenId) => ({ tokenId, staked: true, gauge: gauge as `0x${string}` | null })),
    ),
  ];
  if (allIds.length === 0) return [];

  const detailCalls = allIds.flatMap(({ tokenId, staked, gauge }) => [
    {
      address: npm,
      abi: positionManagerAbi,
      functionName: "positions" as const,
      args: [tokenId] as const,
    },
    staked && gauge
      ? {
          address: gauge,
          abi: clGaugeAbi,
          functionName: "earned" as const,
          args: [owner, tokenId] as const,
        }
      : {
          address: npm,
          abi: positionManagerAbi,
          functionName: "balanceOf" as const,
          args: [owner] as const, // harmless filler to keep stride constant
        },
  ]);
  const details = (await client.multicall({
    contracts: detailCalls as never,
    allowFailure: true,
  })) as { status: string; result?: unknown }[];

  const byPoolKey = new Map(
    snapshots.map((s) => [
      `${s.token0.toLowerCase()}|${s.token1.toLowerCase()}|${s.tickSpacing}`,
      s,
    ]),
  );

  const out: OnchainPosition[] = [];
  allIds.forEach(({ tokenId, staked }, i) => {
    const pos = details[i * 2];
    if (pos?.status !== "success") return;
    const p = pos.result as readonly [
      bigint, string, `0x${string}`, `0x${string}`, number, number, number, bigint, bigint, bigint, bigint, bigint,
    ];
    const [, , token0, token1, tickSpacing, tickLower, tickUpper, liquidity] = p;
    if (liquidity === 0n && !staked) return; // empty husk NFT
    const snap = byPoolKey.get(`${token0.toLowerCase()}|${token1.toLowerCase()}|${tickSpacing}`);
    const earned = details[i * 2 + 1];
    out.push({
      tokenId,
      pool: snap?.pool ?? null,
      pair: snap?.pair ?? null,
      token0,
      token1,
      tickSpacing,
      tickLower,
      tickUpper,
      liquidity,
      staked,
      pendingAero: staked && earned?.status === "success" ? (earned.result as bigint) : null,
    });
  });
  return out;
}

/** Read-only owner address from env; monitoring never touches key material. */
export function resolveOwner(envName: string): `0x${string}` | null {
  const addr = process.env[envName];
  if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) return addr as `0x${string}`;
  return null;
}
