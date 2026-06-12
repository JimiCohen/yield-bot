import { createPublicClient, fallback, http } from "viem";
import { base, optimism } from "viem/chains";
import type { Config } from "../config/schema.js";

export function chainFor(id: number) {
  const chains: Record<number, typeof base> = { 8453: base, 10: optimism as never };
  const c = chains[id];
  if (!c) throw new Error(`unsupported chain id ${id} (supported: 8453 Base, 10 Optimism)`);
  return c;
}

/**
 * Public client with ordered RPC failover. All reads in the bot go through
 * this client; multicall batching keeps us inside public-endpoint rate
 * limits during scans.
 *
 * The concrete return type is exported as ChainClient (Base's OP-stack tx
 * formats make it incompatible with viem's generic PublicClient type).
 */
export function makeClient(cfg: Config) {
  return createPublicClient({
    chain: chainFor(cfg.chain.id),
    transport: fallback(
      cfg.chain.rpc_urls.map((url) =>
        http(url, { retryCount: 2, retryDelay: 500, timeout: 15_000 }),
      ),
    ),
    batch: { multicall: { batchSize: 1024, wait: 50 } },
  });
}

export type ChainClient = ReturnType<typeof makeClient>;
