/**
 * DeFiLlama yields API — DISCOVERY AND SANITY CHECKS ONLY.
 *
 * Per the design rules this data is never used for sizing, allocation, or
 * any execution decision. Its two jobs:
 *   1. Cross-check: a headline APY wildly above what on-chain fee growth +
 *      emissions can support marks the pool as an unreconciled outlier.
 *   2. Discovery hint for pools we might be missing (logged, not acted on).
 *
 * All failures are soft: no Llama data simply means "no advisory APY".
 */

interface LlamaPool {
  chain: string;
  project: string;
  symbol: string;
  pool: string;
  apy?: number;
  underlyingTokens?: string[] | null;
  tvlUsd?: number;
}

export interface LlamaAdvisory {
  /** key: sorted lowercase "tokenA|tokenB" -> best-TVL APY entries */
  byTokenSet: Map<string, { apy: number; tvlUsd: number; symbol: string }[]>;
}

export async function fetchLlamaAdvisory(): Promise<LlamaAdvisory | null> {
  try {
    const res = await fetch("https://yields.llama.fi/pools", {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data: LlamaPool[] };
    const byTokenSet = new Map<string, { apy: number; tvlUsd: number; symbol: string }[]>();
    for (const p of body.data) {
      if (p.chain !== "Base" || p.project !== "aerodrome-slipstream") continue;
      if (!p.underlyingTokens || p.underlyingTokens.length !== 2 || p.apy == null) continue;
      const key = p.underlyingTokens
        .map((t) => t.toLowerCase())
        .sort()
        .join("|");
      const list = byTokenSet.get(key) ?? [];
      list.push({ apy: p.apy, tvlUsd: p.tvlUsd ?? 0, symbol: p.symbol });
      byTokenSet.set(key, list);
    }
    return { byTokenSet };
  } catch {
    return null; // advisory source down — scan proceeds on-chain only
  }
}

/** Best advisory APY for a token pair (highest-TVL entry wins). */
export function advisoryApy(
  adv: LlamaAdvisory | null,
  tokenA: string,
  tokenB: string,
): number | null {
  if (!adv) return null;
  const key = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort().join("|");
  const list = adv.byTokenSet.get(key);
  if (!list || list.length === 0) return null;
  list.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return list[0]?.apy ?? null;
}
