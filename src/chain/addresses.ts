/**
 * Aerodrome protocol addresses on Base mainnet.
 *
 * These are protocol-level singletons. They are verified implicitly on every
 * scan: if the factory address were wrong, getPool() probes would fail or
 * return zero for known-live pairs; if the Voter were wrong, gauge lookups
 * for known-incentivized pools would return zero. The scanner treats either
 * symptom as a fatal misconfiguration, not as "no pools found".
 */
// NOTE: mutable on purpose — applyProtocolConfig() rewrites these when a
// config provides a `protocol:` section (e.g. Velodrome on Optimism), so
// every use site picks up the venue without threading config everywhere.
export const AERODROME = {
  /** Slipstream (concentrated liquidity) pool factory */
  clFactory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
  /**
   * Second Slipstream factory. Discovered live (2026-06-11) via
   * pool.factory() of an active high-TVL pool the first factory doesn't
   * know: Aerodrome runs TWO CL factories and discovery must probe both.
   * CAUTION for live execution: the verified SwapRouter belongs to the
   * first factory; swaps through pools from this factory may need their
   * own router — verify before any live trade routes through them.
   */
  clFactory2: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  /** Slipstream NonfungiblePositionManager (Phase 4+: position ops) */
  positionManager: "0x827922686190790b37229fd06084350E74485b72",
  /** Aerodrome Voter — canonical gauge registry + alive/killed status */
  voter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
  /** AERO emission token */
  aero: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  /**
   * Slipstream SwapRouter. UNVERIFIED-BY-DEFAULT: the execution layer
   * refuses to use it until verifySwapRouter() confirms on-chain that its
   * factory() matches clFactory. Never trust a hardcoded router with funds.
   */
  swapRouter: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
};

/**
 * Per-factory periphery. Sources: factory1 set from original deployment;
 * factory2 ("Gauges V3", dynamic tick-crossing fees) from the official
 * aerodrome-finance/slipstream repo — BOTH router and NPM re-verified
 * on-chain (factory() getters) before being trusted here, and re-verified
 * at every live startup.
 */
export const PERIPHERY: Record<
  string,
  { swapRouter: `0x${string}`; positionManager: `0x${string}` }
> = {
  [AERODROME.clFactory.toLowerCase()]: {
    swapRouter: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
    positionManager: "0x827922686190790b37229fd06084350E74485b72",
  },
  [AERODROME.clFactory2.toLowerCase()]: {
    swapRouter: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
    positionManager: "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53",
  },
};

/** Venue override from config (`protocol:` section). Mutates the shared
 *  address objects in place so all modules see the configured venue. */
export function applyProtocolConfig(p?: {
  cl_factories: string[];
  voter: string;
  emission_token: { address: string; symbol: string; decimals: number };
  periphery: Record<string, { swap_router: string; position_manager: string }>;
}): void {
  if (!p) return;
  AERODROME.clFactory = p.cl_factories[0]!;
  AERODROME.clFactory2 = p.cl_factories[1] ?? p.cl_factories[0]!;
  AERODROME.voter = p.voter;
  AERODROME.aero = p.emission_token.address;
  for (const k of Object.keys(PERIPHERY)) delete PERIPHERY[k];
  for (const [factory, per] of Object.entries(p.periphery)) {
    PERIPHERY[factory.toLowerCase()] = {
      swapRouter: per.swap_router as `0x${string}`,
      positionManager: per.position_manager as `0x${string}`,
    };
  }
  AERODROME.positionManager =
    Object.values(PERIPHERY)[0]?.positionManager ?? AERODROME.positionManager;
  AERODROME.swapRouter = Object.values(PERIPHERY)[0]?.swapRouter ?? AERODROME.swapRouter;
}
