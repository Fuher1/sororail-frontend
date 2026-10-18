import { describe, expect, it } from "vitest";

import { TESTNET_DEFAULTS, validateTestnetDefaults } from "../src/config.js";
import { ValidationError } from "../src/errors/index.js";

describe("TESTNET_DEFAULTS (#243)", () => {
  it("exports valid defaults at module load time", () => {
    expect(TESTNET_DEFAULTS.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(TESTNET_DEFAULTS.networkPassphrase).toBeTruthy();
    expect(TESTNET_DEFAULTS.nativeToken).toBeTruthy();
  });

  describe("validateTestnetDefaults", () => {
    it("passes for valid configuration", () => {
      expect(() => validateTestnetDefaults(TESTNET_DEFAULTS)).not.toThrow();
      expect(() =>
        validateTestnetDefaults({
          rpcUrl: "http://localhost:8000",
          networkPassphrase: "Test SDF Network ; September 2015",
        }),
      ).not.toThrow();
    });

    it("rejects non-string or empty rpcUrl", () => {
      expect(() =>
        validateTestnetDefaults({
          rpcUrl: "",
          networkPassphrase: "Test SDF Network ; September 2015",
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateTestnetDefaults({
          rpcUrl: "   ",
          networkPassphrase: "Test SDF Network ; September 2015",
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateTestnetDefaults({
          rpcUrl: null,
          networkPassphrase: "Test SDF Network ; September 2015",
        }),
      ).toThrow(ValidationError);
    });

    it("rejects invalid URL format for rpcUrl", () => {
      expect(() =>
        validateTestnetDefaults({
          rpcUrl: "not-a-valid-url",
          networkPassphrase: "Test SDF Network ; September 2015",
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateTestnetDefaults({
          rpcUrl: "http://",
          networkPassphrase: "Test SDF Network ; September 2015",
        }),
      ).toThrow(/not a valid URL/);
    });

    it("rejects non-string or empty networkPassphrase", () => {
      expect(() =>
        validateTestnetDefaults({
          rpcUrl: "https://soroban-testnet.stellar.org",
          networkPassphrase: "",
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateTestnetDefaults({
          rpcUrl: "https://soroban-testnet.stellar.org",
          networkPassphrase: "   ",
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateTestnetDefaults({
          rpcUrl: "https://soroban-testnet.stellar.org",
          networkPassphrase: 123,
        }),
      ).toThrow(ValidationError);
    });
  });
});
