import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { getAddress } from "viem";
import { configSchema, type Config } from "./schema.js";
import { applyProtocolConfig } from "../chain/addresses.js";

/**
 * Load and validate config. Fails loudly on any schema violation — a bot
 * running with a half-understood config is worse than one that won't start.
 */
export function loadConfig(path = "config.yaml"): Config {
  const raw = parse(readFileSync(path, "utf8"));
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${path}:\n${issues}`);
  }
  const cfg = result.data;

  // Normalize every token address to its canonical EIP-55 checksum. viem
  // rejects mixed-case addresses with a bad checksum at call time, which
  // would silently surface as "pool not found" — fail here instead.
  for (const [sym, t] of Object.entries(cfg.allowlist.tokens)) {
    try {
      t.address = getAddress(t.address.toLowerCase());
    } catch {
      throw new Error(`allowlist.tokens.${sym}: invalid address ${t.address}`);
    }
  }

  // Sanity: every pair must reference allowlisted tokens.
  for (const [a, b] of cfg.allowlist.pairs) {
    for (const sym of [a, b]) {
      if (!cfg.allowlist.tokens[sym]) {
        throw new Error(`Pair references token "${sym}" not in allowlist.tokens`);
      }
    }
  }
  if (!cfg.allowlist.tokens["USDC"]) {
    throw new Error("USDC must be in the allowlist (it is the numeraire)");
  }
  applyProtocolConfig(cfg.protocol); // venue override (Velodrome etc.)
  return cfg;
}
