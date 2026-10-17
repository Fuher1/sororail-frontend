import { Address, SorobanDataBuilder, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecurringClient } from "../src/clients/recurring.js";
import { ValidationError } from "../src/errors/index.js";
import {
  CONTRACT,
  PAYEE,
  PAYER,
  TOKEN,
  clientOptions,
  contractInvocation,
  mockRpc,
  simulation,
} from "./helpers/rpc.js";

const authorization = {
  payer: PAYER,
  payee: PAYEE,
  token: TOKEN,
  amountPerPeriod: 9_007_199_254_740_993n,
  periodSeconds: 2_592_000n,
};

let rpc: ReturnType<typeof mockRpc>;
beforeEach(() => {
  rpc = mockRpc();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("RecurringClient.authorize", () => {
  it.each([
    ["zero amount", { amountPerPeriod: 0n }, "The amount per period must be greater than zero."],
    ["negative amount", { amountPerPeriod: -1n }, "The amount per period must be greater than zero."],
    ["zero period", { periodSeconds: 0n }, "The period must be greater than zero."],
    ["negative period", { periodSeconds: -1n }, "The period must be greater than zero."],
  ] as const)("rejects a %s before accessing RPC", (_label, invalid, message) => {
    const client = new RecurringClient(clientOptions);
    expect(() => client.authorize({ ...authorization, ...invalid })).toThrow(ValidationError);
    expect(() => client.authorize({ ...authorization, ...invalid })).toThrow(message);
    expect(rpc.getAccount).not.toHaveBeenCalled();
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
    "rejects maxPeriods=%s before accessing RPC", (maxPeriods) => {
      const client = new RecurringClient(clientOptions);
      expect(() => client.authorize({ ...authorization, maxPeriods })).toThrow(ValidationError);
      expect(() => client.authorize({ ...authorization, maxPeriods })).toThrow(
        "maxPeriods must be a whole number of at least 1, or omitted for open-ended.",
      );
      expect(rpc.getAccount).not.toHaveBeenCalled();
      expect(rpc.simulateTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["omitted", {}],
    ["null", { maxPeriods: null }],
    ["one period", { maxPeriods: 1 }],
    ["multiple periods", { maxPeriods: 12 }],
  ] as const)("encodes an authorization with %s maxPeriods", async (_label, cap) => {
    rpc.simulateTransaction.mockResolvedValue(simulation(xdr.ScVal.scvVoid()));
    const call = await new RecurringClient(clientOptions).authorize({ ...authorization, ...cap });
    const prepared = contractInvocation(call);
    const maxPeriods = "maxPeriods" in cap ? cap.maxPeriods : null;

    expect(Address.fromScAddress(prepared.contractAddress).toString()).toBe(CONTRACT);
    expect(prepared.functionName.toString()).toBe("authorize");
    expect(prepared.args.map((arg) => scValToNative(arg))).toEqual([
      PAYER, PAYEE, TOKEN, authorization.amountPerPeriod, authorization.periodSeconds, maxPeriods,
    ]);
    expect(prepared.args.map((arg) => arg.type)).toEqual([
      "scvAddress", "scvAddress", "scvAddress", "scvI128", "scvU64",
      maxPeriods === null ? "scvVoid" : "scvU32",
    ]);
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
    await expect(call.simulate()).resolves.toBeUndefined();
  });
});

describe("RecurringClient.nextChargeableAt", () => {
  it.each([
    ["zero (epoch)", 0n],
    ["typical future timestamp", 1_900_000_000n],
    ["large u64 value beyond Number.MAX_SAFE_INTEGER", 9_007_199_254_740_993n],
  ] as const)("decodes a u64 timestamp %s as bigint without loss", async (_label, timestamp) => {
    rpc.simulateTransaction.mockResolvedValue(simulation(nativeToScVal(timestamp, { type: "u64" })));
    const result = await new RecurringClient(clientOptions).nextChargeableAt();
    expect(typeof result).toBe("bigint");
    expect(result).toBe(timestamp);
    expect(rpc.getAccount).toHaveBeenCalledWith(PAYER);
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("sends the correct contract invocation with no arguments", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(nativeToScVal(1_900_000_000n, { type: "u64" })));
    await new RecurringClient(clientOptions).nextChargeableAt();
    const transaction = rpc.simulateTransaction.mock.calls[0]![0];
    const invocation = contractInvocation(transaction);
    expect(Address.fromScAddress(invocation.contractAddress).toString()).toBe(CONTRACT);
    expect(invocation.functionName.toString()).toBe("next_chargeable_at");
    expect(invocation.args).toEqual([]);
  });

  it("rejects a non-integer return value", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(xdr.ScVal.scvBool(true)));
    const result = new RecurringClient(clientOptions).nextChargeableAt();
    await expect(result).rejects.toThrow(ValidationError);
    await expect(result).rejects.toThrow(/next_chargeable_at/);
  });
});

describe("RecurringClient.remainingPeriods", () => {
  /** Builds a success simulation response where `result.retval` is absent. */
  function simulationNoRetval(): object {
    return {
      id: "test-simulation",
      _parsed: true,
      latestLedger: 1,
      events: [],
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "0",
      result: { auth: [], retval: undefined },
    };
  }

  it("returns null for scvVoid (open-ended subscription)", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(xdr.ScVal.scvVoid()));
    const result = await new RecurringClient(clientOptions).remainingPeriods();
    expect(result).toBeNull();
    expect(rpc.getAccount).toHaveBeenCalledWith(PAYER);
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns null when retval is absent (undefined)", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulationNoRetval() as never);
    const result = await new RecurringClient(clientOptions).remainingPeriods();
    expect(result).toBeNull();
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["1 (minimum cap)", 1],
    ["12 (monthly for a year)", 12],
    ["Number.MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
  ] as const)("decodes a present Option as a number — %s", async (_label, periods) => {
    rpc.simulateTransaction.mockResolvedValue(
      simulation(nativeToScVal(periods, { type: "u32" })),
    );
    const result = await new RecurringClient(clientOptions).remainingPeriods();
    expect(typeof result).toBe("number");
    expect(result).toBe(periods);
  });

  it("sends the correct contract invocation with no arguments", async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulation(nativeToScVal(3, { type: "u32" })),
    );
    await new RecurringClient(clientOptions).remainingPeriods();
    const transaction = rpc.simulateTransaction.mock.calls[0]![0];
    const invocation = contractInvocation(transaction);
    expect(Address.fromScAddress(invocation.contractAddress).toString()).toBe(CONTRACT);
    expect(invocation.functionName.toString()).toBe("remaining_periods");
    expect(invocation.args).toEqual([]);
  });

  it("rejects a present value that is not a number", async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulation(xdr.ScVal.scvBool(true)),
    );
    const result = new RecurringClient(clientOptions).remainingPeriods();
    await expect(result).rejects.toThrow(ValidationError);
    await expect(result).rejects.toThrow(/remaining_periods/);
  });
});

describe("RecurringClient.get", () => {
  /**
   * Builds the scvMap the contract returns for an Authorization struct.
   * Keys are the Soroban snake_case field names, sorted alphabetically to
   * match how the stellar-sdk serialises maps from native objects.
   */
  function authorizationValue(maxPeriods: xdr.ScVal): xdr.ScVal {
    const fields: Record<string, xdr.ScVal> = {
      amount_per_period: nativeToScVal(9_007_199_254_740_993n, { type: "i128" }),
      cancelled: nativeToScVal(false, { type: "bool" }),
      max_periods: maxPeriods,
      next_chargeable_at: nativeToScVal(1_900_000_000n, { type: "u64" }),
      payee: nativeToScVal(PAYEE, { type: "address" }),
      payer: nativeToScVal(PAYER, { type: "address" }),
      period_seconds: nativeToScVal(2_592_000n, { type: "u64" }),
      periods_charged: nativeToScVal(3, { type: "u32" }),
      token: nativeToScVal(TOKEN, { type: "address" }),
    };
    return xdr.ScVal.scvMap(
      Object.entries(fields)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
    );
  }

  it.each([
    ["present (capped)", nativeToScVal(12, { type: "u32" }), 12],
    ["void (open-ended)", xdr.ScVal.scvVoid(), null],
  ] as const)(
    "maps the full authorization with max_periods %s",
    async (_label, maxPeriodsScVal, maxPeriods) => {
      rpc.simulateTransaction.mockResolvedValue(
        simulation(authorizationValue(maxPeriodsScVal)),
      );

      await expect(new RecurringClient(clientOptions).get()).resolves.toEqual({
        payer: PAYER,
        payee: PAYEE,
        token: TOKEN,
        amountPerPeriod: 9_007_199_254_740_993n,
        periodSeconds: 2_592_000n,
        maxPeriods,
        periodsCharged: 3,
        nextChargeableAt: 1_900_000_000n,
        cancelled: false,
      });

      expect(rpc.getAccount).toHaveBeenCalledWith(PAYER);
      expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it("maps a cancelled authorization", async () => {
    const fields: Record<string, xdr.ScVal> = {
      amount_per_period: nativeToScVal(500n, { type: "i128" }),
      cancelled: nativeToScVal(true, { type: "bool" }),
      max_periods: xdr.ScVal.scvVoid(),
      next_chargeable_at: nativeToScVal(1_800_000_000n, { type: "u64" }),
      payee: nativeToScVal(PAYEE, { type: "address" }),
      payer: nativeToScVal(PAYER, { type: "address" }),
      period_seconds: nativeToScVal(86_400n, { type: "u64" }),
      periods_charged: nativeToScVal(0, { type: "u32" }),
      token: nativeToScVal(TOKEN, { type: "address" }),
    };
    rpc.simulateTransaction.mockResolvedValue(
      simulation(
        xdr.ScVal.scvMap(
          Object.entries(fields)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
        ),
      ),
    );

    const result = await new RecurringClient(clientOptions).get();
    expect(result.cancelled).toBe(true);
    expect(result.periodsCharged).toBe(0);
    expect(result.maxPeriods).toBeNull();
  });

  it("sends the correct contract invocation with no arguments", async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulation(authorizationValue(xdr.ScVal.scvVoid())),
    );
    await new RecurringClient(clientOptions).get();
    const transaction = rpc.simulateTransaction.mock.calls[0]![0];
    const invocation = contractInvocation(transaction);
    expect(Address.fromScAddress(invocation.contractAddress).toString()).toBe(CONTRACT);
    expect(invocation.functionName.toString()).toBe("get");
    expect(invocation.args).toEqual([]);
  });

  it("rejects when the return value is not a struct", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(xdr.ScVal.scvBool(true)));
    const result = new RecurringClient(clientOptions).get();
    await expect(result).rejects.toThrow(ValidationError);
    await expect(result).rejects.toThrow(/Authorization/);
  });

  it("rejects when a required field holds the wrong type", async () => {
    // amount_per_period is a string instead of i128 — asRecord parses fine but
    // asBigInt should throw when it processes amount_per_period.
    const fields: Record<string, xdr.ScVal> = {
      amount_per_period: xdr.ScVal.scvBool(true), // wrong type
      cancelled: nativeToScVal(false, { type: "bool" }),
      max_periods: xdr.ScVal.scvVoid(),
      next_chargeable_at: nativeToScVal(1_900_000_000n, { type: "u64" }),
      payee: nativeToScVal(PAYEE, { type: "address" }),
      payer: nativeToScVal(PAYER, { type: "address" }),
      period_seconds: nativeToScVal(2_592_000n, { type: "u64" }),
      periods_charged: nativeToScVal(3, { type: "u32" }),
      token: nativeToScVal(TOKEN, { type: "address" }),
    };
    rpc.simulateTransaction.mockResolvedValue(
      simulation(
        xdr.ScVal.scvMap(
          Object.entries(fields)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
        ),
      ),
    );
    const result = new RecurringClient(clientOptions).get();
    await expect(result).rejects.toThrow(ValidationError);
    await expect(result).rejects.toThrow(/amount_per_period/);
  });
});

describe("RecurringClient.charge", () => {
  it.each([0n, 750n, 9_007_199_254_740_993n])(
    "decodes the i128 amount %s without losing precision", async (amount) => {
      rpc.simulateTransaction.mockResolvedValue(simulation(nativeToScVal(amount, { type: "i128" })));
      const call = await new RecurringClient(clientOptions).charge();
      const prepared = contractInvocation(call);

      expect(Address.fromScAddress(prepared.contractAddress).toString()).toBe(CONTRACT);
      expect(prepared.functionName.toString()).toBe("charge");
      expect(prepared.args).toEqual([]);
      const result = await call.simulate();
      expect(typeof result).toBe("bigint");
      expect(result).toBe(amount);
    },
  );

  it("normalizes an integer ScVal to bigint through the amount parser", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(nativeToScVal(750, { type: "u32" })));
    const call = await new RecurringClient(clientOptions).charge();
    await expect(call.simulate()).resolves.toBe(750n);
  });

  it("rejects a non-integer return value", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(xdr.ScVal.scvBool(true)));
    const call = await new RecurringClient(clientOptions).charge();
    const result = call.simulate();
    await expect(result).rejects.toThrow(ValidationError);
    await expect(result).rejects.toThrow(/amount/);
  });
});
