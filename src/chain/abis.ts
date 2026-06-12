import { parseAbi } from "viem";

/** Slipstream CLFactory — pools are keyed by (tokenA, tokenB, tickSpacing). */
export const clFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
]);

/**
 * Slipstream CLPool. Note: slot0 differs from Uniswap v3 (no feeProtocol
 * field), and stakedLiquidity is Slipstream-specific — it is the share of
 * in-range liquidity that is gauge-staked (earning AERO instead of fees).
 */
export const clPoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function stakedLiquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  // Fee growth per unit of (unstaked) liquidity, X128 fixed point. Measuring
  // the delta over a window gives exactly what an unstaked LP earned per
  // liquidity unit — regardless of how the pool splits fees internally
  // between unstaked LPs and the gauge/voters.
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
  // UniV3-style oracle; cardinality is often small on Aerodrome pools, so
  // callers must handle OLD reverts and degrade gracefully.
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);

/** Aerodrome Voter — canonical registry of gauges and their alive status. */
export const voterAbi = parseAbi([
  "function gauges(address pool) view returns (address)",
  "function isAlive(address gauge) view returns (bool)",
]);

/** Slipstream CLGauge — rewardRate is AERO (1e18) per second. */
export const clGaugeAbi = parseAbi([
  "function rewardRate() view returns (uint256)",
  "function periodFinish() view returns (uint256)",
  // Staked-position introspection: NFTs deposited into the gauge are owned
  // by the gauge contract; these map them back to the depositor.
  "function stakedValues(address depositor) view returns (uint256[])",
  "function earned(address account, uint256 tokenId) view returns (uint256)",
]);

/** Slipstream NonfungiblePositionManager. */
export const positionManagerAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function approve(address to, uint256 tokenId)",
  "struct MintParams { address token0; address token1; int24 tickSpacing; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; uint160 sqrtPriceX96; }",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }",
  "function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)",
  "struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }",
  "function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable",
]);

/** Slipstream SwapRouter. Address verified at runtime via factory(). */
export const swapRouterAbi = parseAbi([
  "function factory() view returns (address)",
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; int24 tickSpacing; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

/** CLGauge write functions (stake lifecycle + claiming). */
export const clGaugeWriteAbi = parseAbi([
  "function deposit(uint256 tokenId)",
  "function withdraw(uint256 tokenId)",
  "function getReward(uint256 tokenId)",
]);

export const erc20WriteAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);
