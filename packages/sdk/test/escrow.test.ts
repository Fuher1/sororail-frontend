import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EscrowClient } from "../src/clients/escrow.js";
import { ValidationError } from "../src/errors/index.js";
import { EscrowState } from "../src/types/index.js";
import {
  ARBITER,
  CONTRACT,
  PAYEE,
  PAYER,
  TOKEN,
  clientOptions,
  contractInvocation,
  mockRpc,
  simulation,
} from "./helpers/rpc.js";

const AMOUNT = 9_007_199_254_740_993n;
const DEADLINE = 1_900_000_000n;

function escrowValue(arbiter: xdr.ScVal | undefined, state: xdr.ScVal): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    depositor: nativeToScVal(PAYER, { type: "address" }),
    beneficiary: nativeToScVal(PAYEE, { type: "address" }),
    token: nativeToScVal(TOKEN, { type: "address" }),
    amount: nativeToScVal(AMOUNT, { type: "i128" }),
    deadline: nativeToScVal(DEADLINE, { type: "u64" }),
    state,
  };
  if (arbiter !== undefined) fields["arbiter"] = arbiter;
  return xdr.ScVal.scvMap(Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol(key), val,
    })));
}

describe("EscrowClient.refund", () => {
  let rpc: ReturnType<typeof mockRpc>;

  beforeEach(() => {
    rpc = mockRpc();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encodes the caller's publicKey as an address argument", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(xdr.ScVal.scvVoid()));

    await new EscrowClient(clientOptions).refund();

    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    const transaction = rpc.simulateTransaction.mock.calls[0]![0];
    const invocation = contractInvocation(transaction);
    expect(Address.fromScAddress(invocation.contractAddress).toString()).toBe(CONTRACT);
    expect(invocation.functionName.toString()).toBe("refund");
    expect(invocation.args).toHaveLength(1);
    expect(Address.fromScVal(invocation.args[0]!).toString()).toBe(PAYER);
  });

  it("rejects when publicKey is not set", async () => {
    const client = new EscrowClient({ ...clientOptions, publicKey: undefined });
    await expect(client.refund()).rejects.toThrow(ValidationError);
  });
});

describe("EscrowClient.get", () => {
  let rpc: ReturnType<typeof mockRpc>;

  beforeEach(() => {
    rpc = mockRpc();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["present", nativeToScVal(ARBITER, { type: "address" }), ARBITER],
    ["void", xdr.ScVal.scvVoid(), null],
    ["missing", undefined, null],
  ] as const)("maps the full agreement with a %s arbiter", async (_label, value, arbiter) => {
    rpc.simulateTransaction.mockResolvedValue(simulation(
      escrowValue(value, nativeToScVal(EscrowState.Funded, { type: "u32" })),
    ));

    await expect(new EscrowClient(clientOptions).get()).resolves.toEqual({
      depositor: PAYER,
      beneficiary: PAYEE,
      arbiter,
      token: TOKEN,
      amount: AMOUNT,
      deadline: DEADLINE,
      state: "Funded",
    });

    expect(rpc.getAccount).toHaveBeenCalledWith(PAYER);
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    const transaction = rpc.simulateTransaction.mock.calls[0]![0];
    const invocation = contractInvocation(transaction);
    expect(Address.fromScAddress(invocation.contractAddress).toString()).toBe(CONTRACT);
    expect(invocation.functionName.toString()).toBe("get");
    expect(invocation.args).toEqual([]);
  });

  it("accepts a lifecycle state returned by name", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(
      escrowValue(xdr.ScVal.scvVoid(), xdr.ScVal.scvSymbol("Released")),
    ));
    expect((await new EscrowClient(clientOptions).get()).state).toBe("Released");
  });

  it("rejects a present arbiter that is not an address or string", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(
      escrowValue(nativeToScVal(7, { type: "u32" }), nativeToScVal(0, { type: "u32" })),
    ));
    const result = new EscrowClient(clientOptions).get();
    await expect(result).rejects.toThrow(ValidationError);
    await expect(result).rejects.toThrow(/arbiter/);
  });
});
