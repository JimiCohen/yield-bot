/** A point-in-time, on-chain-sourced view of one Slipstream pool. */
export interface PoolSnapshot {
  pool: `0x${string}`;
  /** Which CL factory deployed this pool — selects router/NPM periphery. */
  factory: `0x${string}`;
  /** Human pair label, e.g. "WETH/USDC" (token0/token1 on-chain order). */
  pair: string;
  symbol0: string;
  symbol1: string;
  token0: `0x${string}`;
  token1: `0x${string}`;
  tickSpacing: number;
  /** Pool swap fee in pips (1e-6), e.g. 400 = 0.04%. Slipstream fees are dynamic. */
  feePips: number | null;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** Gauge-staked share of in-range liquidity (earns AERO, forgoes fees). */
  stakedLiquidity: bigint | null;
  /** Raw pool token balances (incl. uncollected fees — a slight TVL overcount). */
  bal0: bigint;
  bal1: bigint;
  /** Pool TVL valued in USDC from on-chain prices. */
  tvlUsdc: number;
  gauge: `0x${string}` | null;
  /** null = no gauge; otherwise Voter.isAlive(gauge). */
  gaugeAlive: boolean | null;
  /** AERO per second, 1e18-scaled, for the whole gauge. */
  rewardRate: bigint | null;
  periodFinish: number | null;
  /** DeFiLlama APY, advisory ONLY (discovery / sanity cross-check). */
  llamaApy: number | null;
  eligible: boolean;
  failReasons: string[];
}
