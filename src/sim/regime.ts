/**
 * Emission-regime history (months back) via DefiLlama yields — no API key.
 *
 * The granular tick-level backtest only reaches ~14 days (public RPCs prune
 * state; archive needs a key). But DefiLlama keeps ~11 MONTHS of daily
 * headline APY (split base=fees / reward=emissions) + TVL per pool. That is
 * enough to answer the question that one good fortnight cannot: is the current
 * profitable regime REPRESENTATIVE, or an unusually high-emission spike?
 *
 * It also computes a persistence signal — current reward APY vs the pool's own
 * trailing median — because the strategy harvests emission carry, and the
 * residual analysis showed that carry is over-credited (it mean-reverts over
 * the hold). current/median >> 1 means "today's emissions are a spike; do not
 * extrapolate them over the 7-day horizon."
 */

const POOLS: { pair: string; uuid: string }[] = [
  { pair: "WETH/USDC", uuid: "10137e20-efbc-4e15-a733-17ecb52c48e8" },
  { pair: "USDC/cbBTC", uuid: "ff82c362-dea1-4946-b3b1-92ebd5100b1e" },
  { pair: "WETH/cbBTC", uuid: "4943b6d2-aad2-4f4d-b56e-93f41ef043aa" },
  { pair: "SOL/USDC", uuid: "a6a1fe38-a220-4f68-a2b9-d2749c3e4664" },
];

type Pt = { timestamp: string; apyReward: number | null; apyBase: number | null; tvlUsd: number | null };
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : 0);

for (const p of POOLS) {
  let data: Pt[];
  try {
    const r = await fetch(`https://yields.llama.fi/chart/${p.uuid}`);
    data = ((await r.json()) as { data: Pt[] }).data;
  } catch (e) {
    console.log(`${p.pair}: fetch failed (${e instanceof Error ? e.message : e})`);
    continue;
  }
  if (!data?.length) {
    console.log(`${p.pair}: no data`);
    continue;
  }
  const byMonth = new Map<string, Pt[]>();
  for (const r of data) {
    const mo = r.timestamp.slice(0, 7);
    (byMonth.get(mo) ?? byMonth.set(mo, []).get(mo)!).push(r);
  }
  console.log(
    `\n=== ${p.pair} (${data.length} daily pts, ${data[0]!.timestamp.slice(0, 10)} → ${data[data.length - 1]!.timestamp.slice(0, 10)}) ===`,
  );
  console.log("month     emisAPY%  feeAPY%        TVL$");
  for (const mo of [...byMonth.keys()].sort()) {
    const rows = byMonth.get(mo)!;
    console.log(
      `${mo}   ${med(rows.map((x) => x.apyReward ?? 0)).toFixed(0).padStart(8)}  ` +
        `${med(rows.map((x) => x.apyBase ?? 0)).toFixed(1).padStart(7)}  ` +
        `${med(rows.map((x) => x.tvlUsd ?? 0)).toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(12)}`,
    );
  }
  const rew = data.map((x) => x.apyReward ?? 0);
  const allMed = med(rew);
  const cur = med(rew.slice(-7)); // last week
  console.log(
    `  emissions now (7d med): ${cur.toFixed(0)}%  |  11-mo median: ${allMed.toFixed(0)}%  |  ` +
      `persistence = median/now = ${allMed > 0 && cur > 0 ? (allMed / cur).toFixed(2) : "n/a"} ` +
      `(<<1 ⇒ today is a spike; discount forward emissions)`,
  );
}
console.log(
  "\nGranular net-alpha backtest months back needs an ARCHIVE RPC (free public ones prune state).\n" +
    "Add one keyed endpoint to config chain.rpc_urls and re-run `npm run residuals` with larger --days.",
);
