import type { ChainClient } from "../chain/client.js";
import type { Config } from "../config/schema.js";

/**
 * Allocator venues — audited, single-asset USDC yield sources on Base.
 *
 * Design (from the 2026-07 deep-research + 365d rate simulation):
 *  - Organic stablecoin yield is 3–6%; rotation between venues added only
 *    ~$2/yr over parking in the best vault. So the strategy is PARK + GUARD,
 *    not rate-chasing. Fewer moves = less contract surface.
 *  - Decisions use ADVERTISED base APY (DefiLlama apyBase) only as a signal;
 *    the source of truth for accrual is the ON-CHAIN share price
 *    (ERC4626 convertToAssets / Aave normalized income), which cannot be
 *    faked by emissions or marketing.
 */

export interface Venue {
  key: string;
  name: string;
  kind: "erc4626" | "aave-v3";
  /** vault address for erc4626; Pool address for aave */
  address: `0x${string}`;
  llamaPool: string; // DefiLlama pool uuid (advisory APY + TVL)
  /** Risk tier: 1 = blue-chip ($100M+ TVL, top curator/protocol);
   *  2 = solid but smaller/newer; 3 = higher-yield risk markets.
   *  The allocator only parks in tiers <= allocator.max_tier. */
  tier: 1 | 2 | 3;
  /** aToken address (aave-v3 only) — lets G2 read real on-chain TVL. */
  aToken?: `0x${string}`;
}

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export const VENUES: Venue[] = [
  {
    key: "gtusdcp",
    name: "Gauntlet USDC Prime (Morpho)",
    kind: "erc4626",
    address: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
    llamaPool: "e0672197-9f3e-4414-bca5-e6b4c90aa469",
    tier: 1,
  },
  {
    key: "steakprime",
    name: "Steakhouse Prime USDC (Morpho)",
    kind: "erc4626",
    address: "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2",
    llamaPool: "7820bd3c-461a-4811-9f0b-1d39c1503c3f",
    tier: 1,
  },
  {
    key: "mwflagship",
    name: "Moonwell Flagship USDC (Morpho)",
    kind: "erc4626",
    address: "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca",
    llamaPool: "b39b492a-0a64-4926-8598-d5acf05d62b5",
    tier: 2,
  },
  {
    key: "aave",
    name: "Aave v3 USDC (Base)",
    kind: "aave-v3",
    address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    llamaPool: "7e0661bf-8cf3-45e6-9424-31916d4c7b84",
    tier: 1,
    aToken: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", // aBasUSDC (verified via totalSupply read at startup)
  },
  {
    key: "fluid",
    name: "Fluid USDC (Base)",
    kind: "erc4626",
    // fToken from Fluid's own API (asset == USDC, ERC4626-compliant); the
    // on-chain asset() check below re-verifies every cycle before use.
    address: "0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169",
    llamaPool: "7372edda-f07f-4598-83e5-4edec48c4039",
    tier: 2, // organic 5%+ but ~$8.5M TVL — smaller pool, rate compresses with inflows
  },
  {
    key: "sparkvault",
    name: "Spark USDC Vault (Morpho)",
    kind: "erc4626",
    address: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A",
    llamaPool: "a5fab52f-73fa-4f44-9c09-9af1eb20996c",
    tier: 2,
  },
  {
    key: "bbqusdc",
    name: "Steakhouse High Yield USDC (Morpho)",
    kind: "erc4626",
    address: "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
    llamaPool: "bf346d43-ef94-4277-b159-ebadb93caef1",
    tier: 3, // "High Yield" = riskier collateral markets; excluded at default max_tier
  },
];

const erc4626Abi = [
  { name: "convertToAssets", type: "function", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { name: "totalAssets", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "asset", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const aavePoolAbi = [
  { name: "getReserveNormalizedIncome", type: "function", stateMutability: "view", inputs: [{ name: "asset", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface VenueReading {
  key: string;
  /** On-chain accrual index, normalized to 1e18 at first principles:
   *  erc4626 → assets per 1e18 shares; aave → normalized income (ray/1e9). */
  index: bigint;
  /** On-chain sanity: vault really holds USDC / pool really serves USDC. */
  verified: boolean;
  totalAssetsUsd: number | null;
}

/** Read the truth from chain for one venue. Throws on RPC failure. */
export async function readVenue(client: ChainClient, v: Venue): Promise<VenueReading> {
  if (v.kind === "erc4626") {
    // Probe with 1e24 shares (not 1e18): convertToAssets is linear, and the
    // extra 6 digits make even minutes of accrual measurable for a 6-decimal
    // asset (at 1e18 the hourly growth rounded to ~5 units).
    const [assets, asset, totalAssets] = await Promise.all([
      client.readContract({ address: v.address, abi: erc4626Abi, functionName: "convertToAssets", args: [10n ** 24n] }) as Promise<bigint>,
      client.readContract({ address: v.address, abi: erc4626Abi, functionName: "asset" }) as Promise<string>,
      client.readContract({ address: v.address, abi: erc4626Abi, functionName: "totalAssets" }) as Promise<bigint>,
    ]);
    return {
      key: v.key,
      index: assets,
      verified: asset.toLowerCase() === USDC_BASE.toLowerCase(),
      totalAssetsUsd: Number(totalAssets) / 1e6,
    };
  }
  // Aave v3: normalized income is a ray (1e27) that only ever grows.
  const income = (await client.readContract({
    address: v.address,
    abi: aavePoolAbi,
    functionName: "getReserveNormalizedIncome",
    args: [USDC_BASE],
  })) as bigint;
  // Real TVL from the aToken supply (G2 drain detection without the API).
  let tvl: number | null = null;
  if (v.aToken) {
    try {
      const supply = (await client.readContract({
        address: v.aToken,
        abi: [{ name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const,
        functionName: "totalSupply",
      })) as bigint;
      tvl = Number(supply) / 1e6;
    } catch {
      tvl = null; // wrong/changed aToken → fail open, advisory covers it
    }
  }
  return { key: v.key, index: income / 10n ** 9n, verified: income > 10n ** 26n, totalAssetsUsd: tvl };
}

/** USDC/USD price (advisory, coins.llama.fi). null on failure — fail open. */
export async function fetchUsdcPrice(): Promise<number | null> {
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/base:${USDC_BASE}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json()) as { coins: Record<string, { price: number }> };
    return j.coins[`base:${USDC_BASE}`]?.price ?? null;
  } catch {
    return null;
  }
}

/** Advisory rates (advertised apyBase + TVL) from DefiLlama — signal only. */
export async function fetchAdvisoryRates(
  venues: Venue[],
): Promise<Record<string, { apyBase: number; tvlUsd: number } | null>> {
  const out: Record<string, { apyBase: number; tvlUsd: number } | null> = {};
  let pools: { pool: string; apyBase: number | null; apy: number | null; tvlUsd: number | null }[];
  try {
    const r = await fetch("https://yields.llama.fi/pools", { signal: AbortSignal.timeout(30_000) });
    pools = ((await r.json()) as { data: typeof pools }).data;
  } catch {
    for (const v of venues) out[v.key] = null; // advisory down → guard falls back to on-chain only
    return out;
  }
  for (const v of venues) {
    const p = pools.find((x) => x.pool === v.llamaPool);
    out[v.key] = p ? { apyBase: p.apyBase ?? p.apy ?? 0, tvlUsd: p.tvlUsd ?? 0 } : null;
  }
  return out;
}

/** Annualized yield implied by two on-chain index readings. The honest APY. */
export function impliedAprPct(prev: { index: bigint; ts: number }, cur: { index: bigint; ts: number }): number | null {
  const dtYears = (cur.ts - prev.ts) / (365.25 * 86_400_000);
  if (dtYears <= 0 || prev.index <= 0n) return null;
  const growth = Number(cur.index - prev.index) / Number(prev.index);
  return (growth / dtYears) * 100;
}

/** Allocator-specific config (validated in schema.ts). */
export function allocCfg(cfg: Config) {
  return cfg.allocator;
}
