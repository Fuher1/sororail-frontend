import { Networks } from "@stellar/stellar-sdk";
import { ValidationError } from "./errors/index.js";

/** Shared defaults for the testnet-only examples and reference app. */
export const TESTNET_DEFAULTS = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  nativeToken:
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
} as const;

/**
 * Validates network defaults configuration.
 *
 * Ensures rpcUrl is a valid parseable URL and networkPassphrase is a non-empty string.
 * Throws a ValidationError if any requirement is violated.
 */
export function validateTestnetDefaults(defaults: {
  rpcUrl: unknown;
  networkPassphrase: unknown;
  nativeToken?: unknown;
}): void {
  if (typeof defaults.rpcUrl !== "string" || defaults.rpcUrl.trim() === "") {
    throw new ValidationError("TESTNET_DEFAULTS.rpcUrl must be a non-empty string");
  }
  try {
    new URL(defaults.rpcUrl);
  } catch (cause) {
    throw new ValidationError(
      `TESTNET_DEFAULTS.rpcUrl is not a valid URL: ${defaults.rpcUrl}`,
      { cause },
    );
  }

  if (
    typeof defaults.networkPassphrase !== "string" ||
    defaults.networkPassphrase.trim() === ""
  ) {
    throw new ValidationError(
      "TESTNET_DEFAULTS.networkPassphrase must be a non-empty string",
    );
  }
}

// Validate TESTNET_DEFAULTS at module load/import time
validateTestnetDefaults(TESTNET_DEFAULTS);

