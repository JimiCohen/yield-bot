import { parseEventLogs } from "viem";
import type { Config } from "../config/schema.js";
import { AERODROME } from "../chain/addresses.js";
import {
  clGaugeWriteAbi,
  clPoolAbi,
  erc20WriteAbi,
  positionManagerAbi,
  swapRouterAbi,
} from "../chain/abis.js";
import { deadline, minAmount, minOut, withBackoff } from "./submit.js";
import type { StepDef } from "./machine.js";
import type { makeSigner } from "./signer.js";
import { parseAbi } from "viem";

/**
 * Live action step definitions — Phase 8.
 *
 * Design rules:
 *  - every step's alreadyDone() consults the CHAIN, never the DB
 *  - every swap and liquidity action carries explicit min bounds from the
 *    config slippage caps, plus a short deadline
 *  - context carries only JSON-safe values (amounts as decimal strings)
 *
 * UNTESTED-AGAINST-MAINNET DISCLOSURE: these builders are exercised by the
 * machine tests with mocked steps and typechecked against real ABIs, but no
 * funded wallet has executed them in this environment. First live runs MUST
 * be at minimum size with alerts on. The validation gate in `live` enforces
 * paper-ledger evidence before this code can touch funds at all.
 */

type Signer = ReturnType<typeof makeSigner>;

const erc721TransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export interface EnterCtx {
  pool: string;
  /** position manager for this pool's factory (periphery is per-factory) */
  npm: string;
  pair: string;
  arm: "fees_unstaked" | "emissions_staked";
  gauge: string | null;
  token0: string;
  token1: string;
  dec0: number;
  dec1: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  /** USDC to deploy (raw 6-dec string) */
  usdcIn: string;
  /** target raw amounts (decimal strings), computed in swap step */
  want0?: string;
  want1?: string;
  tokenId?: string;
}

export interface ExitCtx {
  tokenId: string;
  pool: string;
  npm: string;
  pair: string;
  gauge: string | null;
  token0: string;
  token1: string;
}

/** token (lowercase) -> the pool to route a token<->USDC swap through,
 *  WITH the router matching that pool's factory. Built from the scanner's
 *  discovered pools (deepest USDC pool per token) plus the AERO pool. */
export type SwapRoutes = Record<
  string,
  { pool: string; tickSpacing: number; router: string }
>;

async function sendAndWait(
  signer: Signer,
  label: string,
  log: (m: string) => void,
  send: () => Promise<`0x${string}`>,
): Promise<void> {
  await withBackoff(label, 3, async () => {
    const hash = await send();
    log(`    tx ${label}: ${hash}`);
    const receipt = await signer.wallet.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  }, log);
}

/** Spot-quote a swap from pool state and apply the config slippage cap. */
async function quoteMinOut(
  signer: Signer,
  cfg: Config,
  pool: string,
  tokenIn: string,
  amountIn: bigint,
): Promise<bigint> {
  const [slot0, token0, fee] = await Promise.all([
    signer.wallet.readContract({ address: pool as `0x${string}`, abi: clPoolAbi, functionName: "slot0" }),
    signer.wallet.readContract({ address: pool as `0x${string}`, abi: clPoolAbi, functionName: "token0" }),
    signer.wallet.readContract({ address: pool as `0x${string}`, abi: clPoolAbi, functionName: "fee" }),
  ]);
  const sqrtP = (slot0 as readonly [bigint, ...unknown[]])[0];
  const inIs0 = (token0 as string).toLowerCase() === tokenIn.toLowerCase();
  // out = in * price (raw), price(token1 per token0) = (sqrtP/2^96)^2
  const num = sqrtP * sqrtP;
  const q192 = 1n << 192n;
  const grossOut = inIs0 ? (amountIn * num) / q192 : (amountIn * q192) / num;
  const afterFee = (grossOut * (1_000_000n - BigInt(Number(fee)))) / 1_000_000n;
  return minOut(afterFee, cfg);
}

async function ensureAllowance(
  signer: Signer,
  log: (m: string) => void,
  token: string,
  spender: string,
  amount: bigint,
): Promise<void> {
  const allowance = (await signer.wallet.readContract({
    address: token as `0x${string}`,
    abi: erc20WriteAbi,
    functionName: "allowance",
    args: [signer.address, spender as `0x${string}`],
  })) as bigint;
  if (allowance >= amount) return;
  await sendAndWait(signer, `approve ${token.slice(0, 8)}`, log, () =>
    signer.wallet.writeContract({
      address: token as `0x${string}`,
      abi: erc20WriteAbi,
      functionName: "approve",
      args: [spender as `0x${string}`, amount],
    }),
  );
}

async function balanceOf(signer: Signer, token: string): Promise<bigint> {
  return (await signer.wallet.readContract({
    address: token as `0x${string}`,
    abi: erc20WriteAbi,
    functionName: "balanceOf",
    args: [signer.address],
  })) as bigint;
}

async function swapExactIn(
  signer: Signer,
  cfg: Config,
  log: (m: string) => void,
  route: { pool: string; tickSpacing: number; router: string },
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<void> {
  if (amountIn === 0n) return;
  const { pool, tickSpacing, router } = route;
  await ensureAllowance(signer, log, tokenIn, router, amountIn);
  const outMin = await quoteMinOut(signer, cfg, pool, tokenIn, amountIn);
  await sendAndWait(signer, `swap ${tokenIn.slice(0, 8)}->${tokenOut.slice(0, 8)}`, log, () =>
    signer.wallet.writeContract({
      address: router as `0x${string}`,
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: tokenIn as `0x${string}`,
          tokenOut: tokenOut as `0x${string}`,
          tickSpacing,
          recipient: signer.address,
          deadline: deadline(),
          amountIn,
          amountOutMinimum: outMin,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  );
}

export function enterSteps(
  cfg: Config,
  signer: Signer,
  usdcAddr: string,
  routes: SwapRoutes,
  log: (m: string) => void,
): StepDef<EnterCtx>[] {
  return [
    {
      name: "swap-to-ratio",
      alreadyDone: async (ctx) => ctx.want0 !== undefined && ctx.tokenId !== undefined,
      execute: async (ctx) => {
        // Target split from band geometry at the current price.
        const slot0 = (await signer.wallet.readContract({
          address: ctx.pool as `0x${string}`,
          abi: clPoolAbi,
          functionName: "slot0",
        })) as readonly [bigint, number, ...unknown[]];
        const s = Number(slot0[0]) / 2 ** 96;
        const sa = Math.pow(1.0001, ctx.tickLower / 2);
        const sb = Math.pow(1.0001, ctx.tickUpper / 2);
        const sc = Math.min(Math.max(s, sa), sb);
        const amt0PerL = 1 / sc - 1 / sb; // raw token0 per liquidity unit
        const amt1PerL = sc - sa; // raw token1 per liquidity unit
        const v0InT1 = amt0PerL * sc * sc; // token0 leg valued in raw token1
        const f0 = v0InT1 / (v0InT1 + amt1PerL); // value fraction to token0
        const usdcIn = BigInt(ctx.usdcIn);

        const legs: { token: string; usdc: bigint }[] = [
          { token: ctx.token0, usdc: (usdcIn * BigInt(Math.round(f0 * 1e6))) / 1_000_000n },
          { token: ctx.token1, usdc: 0n },
        ];
        legs[1]!.usdc = usdcIn - legs[0]!.usdc;
        for (const leg of legs) {
          if (leg.token.toLowerCase() === usdcAddr.toLowerCase()) continue;
          const route = routes[leg.token.toLowerCase()];
          if (!route) throw new Error(`no USDC swap route for ${leg.token}`);
          await swapExactIn(signer, cfg, log, route, usdcAddr, leg.token, leg.usdc);
        }
        const want0 = (await balanceOf(signer, ctx.token0)).toString();
        const want1 = (await balanceOf(signer, ctx.token1)).toString();
        return { ...ctx, want0, want1 };
      },
    },
    {
      name: "mint",
      alreadyDone: async (ctx) => {
        if (!ctx.tokenId) return false;
        const pos = (await signer.wallet.readContract({
          address: ctx.npm as `0x${string}`,
          abi: positionManagerAbi,
          functionName: "positions",
          args: [BigInt(ctx.tokenId)],
        })) as readonly [bigint, string, string, string, number, number, number, bigint, ...unknown[]];
        return pos[7] > 0n;
      },
      execute: async (ctx) => {
        const a0 = BigInt(ctx.want0 ?? "0");
        const a1 = BigInt(ctx.want1 ?? "0");
        await ensureAllowance(signer, log, ctx.token0, ctx.npm, a0);
        await ensureAllowance(signer, log, ctx.token1, ctx.npm, a1);
        let tokenId: string | undefined;
        await withBackoff("mint", 3, async () => {
          const hash = await signer.wallet.writeContract({
            address: ctx.npm as `0x${string}`,
            abi: positionManagerAbi,
            functionName: "mint",
            args: [
              {
                token0: ctx.token0 as `0x${string}`,
                token1: ctx.token1 as `0x${string}`,
                tickSpacing: ctx.tickSpacing,
                tickLower: ctx.tickLower,
                tickUpper: ctx.tickUpper,
                amount0Desired: a0,
                amount1Desired: a1,
                amount0Min: minAmount(a0, cfg),
                amount1Min: minAmount(a1, cfg),
                recipient: signer.address,
                deadline: deadline(),
                sqrtPriceX96: 0n,
              },
            ],
          });
          log(`    tx mint: ${hash}`);
          const receipt = await signer.wallet.waitForTransactionReceipt({ hash, timeout: 120_000 });
          if (receipt.status !== "success") throw new Error(`mint reverted (${hash})`);
          const transfers = parseEventLogs({
            abi: erc721TransferAbi,
            logs: receipt.logs,
            eventName: "Transfer",
          }).filter(
            (l) =>
              l.address.toLowerCase() === ctx.npm.toLowerCase() &&
              l.args.to.toLowerCase() === signer.address.toLowerCase(),
          );
          if (transfers.length === 0) throw new Error("mint succeeded but no NFT Transfer found");
          tokenId = transfers[0]!.args.tokenId.toString();
        }, log);
        return { ...ctx, tokenId };
      },
    },
    {
      name: "stake",
      alreadyDone: async (ctx) => {
        if (ctx.arm !== "emissions_staked" || !ctx.gauge) return true; // nothing to stake
        if (!ctx.tokenId) return false;
        const owner = (await signer.wallet.readContract({
          address: ctx.npm as `0x${string}`,
          abi: positionManagerAbi,
          functionName: "ownerOf",
          args: [BigInt(ctx.tokenId)],
        })) as string;
        return owner.toLowerCase() === ctx.gauge.toLowerCase();
      },
      execute: async (ctx) => {
        const tokenId = BigInt(ctx.tokenId!);
        await sendAndWait(signer, "approve-gauge", log, () =>
          signer.wallet.writeContract({
            address: ctx.npm as `0x${string}`,
            abi: positionManagerAbi,
            functionName: "approve",
            args: [ctx.gauge as `0x${string}`, tokenId],
          }),
        );
        await sendAndWait(signer, "gauge-deposit", log, () =>
          signer.wallet.writeContract({
            address: ctx.gauge as `0x${string}`,
            abi: clGaugeWriteAbi,
            functionName: "deposit",
            args: [tokenId],
          }),
        );
        return ctx;
      },
    },
  ];
}

export function exitSteps(
  cfg: Config,
  signer: Signer,
  usdcAddr: string,
  routes: SwapRoutes,
  log: (m: string) => void,
): StepDef<ExitCtx>[] {
  const positionsOf = async (tokenId: string, npm: string) =>
    (await signer.wallet.readContract({
      address: npm as `0x${string}`,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [BigInt(tokenId)],
    })) as readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint];

  return [
    {
      name: "unstake",
      alreadyDone: async (ctx) => {
        if (!ctx.gauge) return true;
        const owner = (await signer.wallet.readContract({
          address: ctx.npm as `0x${string}`,
          abi: positionManagerAbi,
          functionName: "ownerOf",
          args: [BigInt(ctx.tokenId)],
        })) as string;
        return owner.toLowerCase() !== ctx.gauge.toLowerCase();
      },
      execute: async (ctx) => {
        // withdraw claims pending AERO as part of the gauge exit
        await sendAndWait(signer, "gauge-withdraw", log, () =>
          signer.wallet.writeContract({
            address: ctx.gauge as `0x${string}`,
            abi: clGaugeWriteAbi,
            functionName: "withdraw",
            args: [BigInt(ctx.tokenId)],
          }),
        );
        return ctx;
      },
    },
    {
      name: "decrease-liquidity",
      alreadyDone: async (ctx) => (await positionsOf(ctx.tokenId, ctx.npm))[7] === 0n,
      execute: async (ctx) => {
        const pos = await positionsOf(ctx.tokenId, ctx.npm);
        const liquidity = pos[7];
        // Expected amounts from band geometry at the current tick; min
        // bounds protect against price movement between quote and landing.
        const slot0 = (await signer.wallet.readContract({
          address: ctx.pool as `0x${string}`,
          abi: clPoolAbi,
          functionName: "slot0",
        })) as readonly [bigint, number, ...unknown[]];
        const s = Number(slot0[0]) / 2 ** 96;
        const sa = Math.pow(1.0001, pos[5] / 2);
        const sb = Math.pow(1.0001, pos[6] / 2);
        const sc = Math.min(Math.max(s, sa), sb);
        const L = Number(liquidity);
        const exp0 = BigInt(Math.floor(L * (1 / sc - 1 / sb)));
        const exp1 = BigInt(Math.floor(L * (sc - sa)));
        await sendAndWait(signer, "decrease", log, () =>
          signer.wallet.writeContract({
            address: ctx.npm as `0x${string}`,
            abi: positionManagerAbi,
            functionName: "decreaseLiquidity",
            args: [
              {
                tokenId: BigInt(ctx.tokenId),
                liquidity,
                amount0Min: minAmount(exp0, cfg),
                amount1Min: minAmount(exp1, cfg),
                deadline: deadline(),
              },
            ],
          }),
        );
        return ctx;
      },
    },
    {
      name: "collect",
      alreadyDone: async (ctx) => {
        const pos = await positionsOf(ctx.tokenId, ctx.npm);
        return pos[10] === 0n && pos[11] === 0n; // tokensOwed0/1
      },
      execute: async (ctx) => {
        const MAX = 2n ** 128n - 1n;
        await sendAndWait(signer, "collect", log, () =>
          signer.wallet.writeContract({
            address: ctx.npm as `0x${string}`,
            abi: positionManagerAbi,
            functionName: "collect",
            args: [
              {
                tokenId: BigInt(ctx.tokenId),
                recipient: signer.address,
                amount0Max: MAX,
                amount1Max: MAX,
              },
            ],
          }),
        );
        return ctx;
      },
    },
    {
      name: "swap-all-to-usdc",
      alreadyDone: async (ctx) => {
        for (const t of [ctx.token0, ctx.token1, AERODROME.aero]) {
          if (t.toLowerCase() === usdcAddr.toLowerCase()) continue;
          if ((await balanceOf(signer, t)) > 0n) return false;
        }
        return true;
      },
      execute: async (ctx) => {
        for (const t of [ctx.token0, ctx.token1, AERODROME.aero]) {
          if (t.toLowerCase() === usdcAddr.toLowerCase()) continue;
          const bal = await balanceOf(signer, t);
          if (bal === 0n) continue;
          const route = routes[t.toLowerCase()];
          if (!route) throw new Error(`no USDC swap route for ${t}`);
          await swapExactIn(signer, cfg, log, route, t, usdcAddr, bal);
        }
        return ctx;
      },
    },
  ];
}
