import { z } from "zod";

const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

const tokenSchema = z.object({
  address: evmAddress,
  decimals: z.number().int().min(0).max(36),
});

export const configSchema = z.object({
  mode: z.enum(["paper", "live"]),
  numeraire: z.literal("USDC"),
  capital_usdc: z.number().positive(),

  chain: z.object({
    id: z.number().int().positive(), // 8453 = Base, 10 = Optimism
    rpc_urls: z.array(z.string().url()).min(1),
  }),

  // Optional protocol override: lets the SAME bot run Velodrome (or any
  // Slipstream-lineage venue) from a second config file. Omitted = Aerodrome.
  protocol: z
    .object({
      cl_factories: z.array(evmAddress).min(1).max(4),
      voter: evmAddress,
      emission_token: z.object({
        address: evmAddress,
        symbol: z.string().min(1),
        decimals: z.number().int(),
      }),
      periphery: z.record(
        z.string(),
        z.object({ swap_router: evmAddress, position_manager: evmAddress }),
      ),
    })
    .optional(),

  allowlist: z.object({
    tokens: z.record(z.string(), tokenSchema),
    pairs: z.array(z.tuple([z.string(), z.string()])).min(1),
  }),

  filters: z.object({
    min_tvl_usdc: z.number().nonnegative(),
    require_alive_gauge: z.boolean(),
  }),

  scanner: z.object({
    tick_spacings: z.array(z.number().int().positive()).min(1),
  }),

  scoring: z.object({
    horizon_days: z.number().min(7), // user-mandated minimum horizon
    confidence_fee: z.number().min(0).max(1),
    // Trailing fee rates mean-revert; this scales the measured rate before
    // projecting it over the horizon. Calibrated against the backtest.
    fee_persistence: z.number().min(0).max(1),
    confidence_emissions: z.number().min(0).max(1),
    emission_haircut: z.number().min(0).max(1),
    emission_decay_30d: z.number().min(0).max(1),
    min_net_yield_apr: z.number(),
    outlier_ratio: z.number().min(1),
    width_grid: z.object({
      min_mult: z.number().gt(1),
      max_mult: z.number().gt(1),
      steps: z.number().int().min(5).max(200),
    }),
  }),

  volatility: z.object({
    ewma_lambda: z.number().gt(0).lt(1),
    // Fallback annualized vol per pair label (token0/token1 on-chain order),
    // used ONLY when no on-chain price history is obtainable. Low confidence.
    fallback_annual: z.record(z.string(), z.number().positive()),
    fallback_default: z.number().positive(),
  }),

  backtest: z.object({
    days: z.number().positive().max(90),
    step_hours: z.number().positive(),
  }),

  // Live-execution gate: the bot refuses to go live until the paper ledger
  // proves the model. This encodes the Phase 3 gate in the binary itself.
  execution: z.object({
    require_validation: z.boolean(),
    validation_min_entries: z.number().int().positive(),
    validation_min_sign_agreement: z.number().min(0).max(1),
    validation_ratio_min: z.number().positive(),
    validation_ratio_max: z.number().positive(),
  }),

  gas: z.object({
    // Gas unit estimates per composite action (sum of the underlying txs).
    // Priced live via eth_gasPrice and the scanned ETH/USDC price.
    enter_gas_units: z.number().int().positive(),
    exit_gas_units: z.number().int().positive(),
    rebalance_gas_units: z.number().int().positive(),
    compound_gas_units: z.number().int().positive(),
  }),

  position: z.object({
    max_pool_fraction: z.number().gt(0).lte(1),
    min_position_usd: z.number().positive(),
    // Simultaneous positions across different pools (the rotation portfolio).
    max_positions: z.number().int().min(1).max(10),
    // Hard ceiling on a SINGLE live position, in USDC. Enforced at the live
    // entry chokepoint regardless of optimizer choice or wallet balance — a
    // belt-and-suspenders bound on first real-money trades. Optional; when
    // unset there is no extra cap beyond the wallet balance and pool fraction.
    max_position_usd: z.number().positive().optional(),
  }),

  // Emission-regime gate: only deploy into pools whose current emissions clear
  // a fraction of their own trailing baseline (DefiLlama, ~11mo). Rides spikes,
  // stands down when carry fades. Fails OPEN (never freezes the bot on missing
  // data). See src/scoring/regime.ts.
  regime: z.object({
    enabled: z.boolean(),
    baseline_lookback_days: z.number().int().positive(),
    // Deploy when current emission APY >= min_ratio x trailing-median APY.
    min_ratio: z.number().gt(0),
    max_staleness_hours: z.number().positive(),
  }),

  rebalance: z.object({
    check_interval_minutes: z.number().positive(),
    deadband_fraction: z.number().min(0).max(1),
    sustain_minutes: z.number().nonnegative(),
    net_benefit_margin: z.number().min(1),
    // No exit/switch before this age (risk triggers bypass). Prevents
    // threshold-flap churn at fast check cadences.
    min_hold_minutes: z.number().nonnegative(),
    switch_margin: z.number().min(1),
    max_rebalances_per_day: z.number().int().positive(),
    timing_jitter_minutes: z.number().nonnegative(),
  }),

  slippage: z.object({
    swap_cap_bps: z.number().positive(),
    liquidity_cap_bps: z.number().positive(),
  }),

  compound: z.object({
    min_cost_multiple: z.number().min(1),
  }),

  risk: z.object({
    usdc_depeg_exit: z.number().gt(0).lt(1.01),
    cbbtc_basis_exit_bps: z.number().positive(),
    tvl_collapse_fraction: z.number().gt(0).lt(1),
    tvl_collapse_window_hours: z.number().positive(),
    // Exit if measured vol exceeds this multiple of the config prior.
    vol_spike_multiple: z.number().gt(1),
  }),

  wallet: z.object({
    private_key_env: z.string().min(1),
    // Read-only monitoring address (no key needed). Optional: paper mode
    // works without any wallet at all.
    address_env: z.string().min(1),
  }),

  alerts: z.object({
    telegram: z.object({
      enabled: z.boolean(),
      bot_token_env: z.string(),
      chat_id_env: z.string(),
    }),
  }),

  db: z.object({ path: z.string().min(1) }),
  audit: z.object({ jsonl_path: z.string().min(1) }),

  server: z.object({
    // 127.0.0.1 ONLY by default: the dashboard can start live trading, so
    // it must never be reachable from the network without your own proxy+auth.
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  }),
});

export type Config = z.infer<typeof configSchema>;
export type TokenInfo = z.infer<typeof tokenSchema>;
