import { createWalletClient, fallback, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor } from "../chain/client.js";
import type { Config } from "../config/schema.js";
import { AERODROME, PERIPHERY } from "../chain/addresses.js";
import { positionManagerAbi, swapRouterAbi } from "../chain/abis.js";
import { parseAbi } from "viem";
import type { ChainClient } from "../chain/client.js";

/**
 * Signer construction. Key material rules:
 *  - read from env ONLY (cfg names the variable, never holds the value)
 *  - never logged, never persisted, never passed beyond this module's return
 *  - the wallet must be a dedicated bot wallet holding only managed capital
 */
export function makeSigner(cfg: Config) {
  const raw = process.env[cfg.wallet.private_key_env];
  if (!raw) {
    throw new Error(
      `No private key in $${cfg.wallet.private_key_env} — live execution requires the env-injected signer.`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`$${cfg.wallet.private_key_env} is not a valid 32-byte hex key.`);
  }
  const account = privateKeyToAccount(raw as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: chainFor(cfg.chain.id),
    transport: fallback(cfg.chain.rpc_urls.map((u) => http(u, { retryCount: 2 }))),
  }).extend(publicActions);
  return { wallet, address: account.address };
}

/**
 * Refuse to route funds through an unverified router: its factory() must be
 * the Slipstream factory we already trust (which the scanner exercises on
 * every run). A typo'd or malicious router fails here, before any approval.
 */
export async function verifySwapRouter(client: ChainClient): Promise<void> {
  const factoryGetter = parseAbi(["function factory() view returns (address)"]);
  for (const [factory, periphery] of Object.entries(PERIPHERY)) {
    for (const [label, addr] of [
      ["SwapRouter", periphery.swapRouter],
      ["PositionManager", periphery.positionManager],
    ] as const) {
      const got = (await client.readContract({
        address: addr,
        abi: factoryGetter,
        functionName: "factory",
      })) as string;
      if (got.toLowerCase() !== factory) {
        throw new Error(
          `${label} ${addr} verification FAILED: factory() = ${got}, expected ${factory}. Refusing to execute.`,
        );
      }
    }
  }
  void swapRouterAbi;
  void positionManagerAbi;
  void AERODROME;
}
