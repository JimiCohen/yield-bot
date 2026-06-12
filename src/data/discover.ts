/**
 * Cross-platform pocket discovery via DeFiLlama (ADVISORY ONLY — every
 * candidate must be verified on-chain before any capital decision).
 *
 * What makes a "pocket": a high REWARD-apy share (emissions, not fees) on a
 * modest TVL — i.e., a big fixed prize divided by little competition. That
 * ratio is exactly what made the Aerodrome tick-1 pools profitable. This
 * tool ranks blue-chip-pair pools across audited ve(3,3)-style venues by
 * prize-to-TVL, so new pockets surface the day they appear.
 */

interface LlamaPool {
  chain: string;
  project: string;
  symbol: string;
  pool: string;
  tvlUsd?: number;
  apy?: number;
  apyReward?: number | null;
  apyBase?: number | null;
  stablecoin?: boolean;
}

/** Audited venues only (user requirement: reputable auditors). */
const VENUES: Record<string, string> = {
  "aerodrome-slipstream": "Aerodrome (Base)",
  "velodrome-v3": "Velodrome CL (Optimism)",
  "velodrome-slipstream": "Velodrome CL (Optimism)",
};

const BLUE_CHIP = /(^|[-/ ])(WETH|ETH|CBBTC|WBTC|BTC|USDC|SOL|WSOL|USDT)([-/ ]|$)/i;

export interface PocketCandidate {
  venue: string;
  chain: string;
  symbol: string;
  poolId: string;
  tvlUsd: number;
  rewardApyPct: number;
  totalApyPct: number;
  /** reward dollars per day per $1k TVL — the pocket-ness score */
  prizeDensity: number;
}

export async function discoverPockets(): Promise<PocketCandidate[]> {
  const res = await fetch("https://yields.llama.fi/pools", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`llama yields: HTTP ${res.status}`);
  const body = (await res.json()) as { data: LlamaPool[] };

  const out: PocketCandidate[] = [];
  for (const p of body.data) {
    const venue = VENUES[p.project];
    if (!venue) continue;
    if (!p.tvlUsd || p.tvlUsd < 50_000 || p.tvlUsd > 5_000_000) continue; // pocket band
    if (!p.apyReward || p.apyReward < 20) continue; // prize-driven only
    const sym = p.symbol.toUpperCase();
    // both legs must be blue-chip
    const legs = sym.split(/[-/]/).filter(Boolean);
    if (legs.length < 2 || !legs.every((l) => BLUE_CHIP.test(l))) continue;
    const rewardUsdPerDay = (p.apyReward / 100 / 365) * p.tvlUsd;
    out.push({
      venue,
      chain: p.chain,
      symbol: p.symbol,
      poolId: p.pool,
      tvlUsd: p.tvlUsd,
      rewardApyPct: p.apyReward,
      totalApyPct: p.apy ?? p.apyReward,
      prizeDensity: (rewardUsdPerDay / p.tvlUsd) * 1000,
    });
  }
  out.sort((a, b) => b.prizeDensity - a.prizeDensity);
  return out;
}
