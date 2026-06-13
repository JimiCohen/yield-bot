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
  // An archive endpoint (deep historical state) can be injected via env so the
  // API key never touches the committed config / public repo. When present it
  // is the PRIMARY transport (backtests need historical eth_call depth that
  // public endpoints prune); the config list stays as fallback.
  const archive = process.env.BASE_ARCHIVE_RPC?.trim();
  const urls = archive ? [archive, ...cfg.chain.rpc_urls] : cfg.chain.rpc_urls;
  return createPublicClient({
    chain: chainFor(cfg.chain.id),
    transport: fallback(
      urls.map((url) => http(url, { retryCount: 2, retryDelay: 500, timeout: 15_000 })),
    ),
    batch: { multicall: { batchSize: 1024, wait: 50 } },
  });
}

export type ChainClient = ReturnType<typeof makeClient>;
