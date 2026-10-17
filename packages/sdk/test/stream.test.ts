import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StreamClient } from "../src/clients/stream.js";
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

const RATE = 1_000_000n;       // 0.1 token/sec in stroops
const START = 1_700_000_000n;
const STOP  = 1_700_003_600n;  // 1 hour later
const DEPOSITED = RATE * (STOP - START);
const WITHDRAWN = 500_000_000n;
const REFUNDED  = 0n;

/**
 * Builds an ScVal map that mirrors what `scValToNative` returns from a
 * serialised Stream contract struct.
 */
function streamValue(cancelledAt: xdr.ScVal | undefined): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    sender:          nativeToScVal(PAYER,      { type: "address" }),
    recipient:       nativeToScVal(PAYEE,      { type: "address" }),
    token:           nativeToScVal(TOKEN,      { type: "address" }),
    rate_per_second: nativeToScVal(RATE,       { type: "i128" }),
    start:           nativeToScVal(START,      { type: "u64" }),
    stop:            nativeToScVal(STOP,       { type: "u64" }),
    cancellable:     nativeToScVal(true,       { type: "bool" }),
    deposited:       nativeToScVal(DEPOSITED,  { type: "i128" }),
    withdrawn:       nativeToScVal(WITHDRAWN,  { type: "i128" }),
    refunded:        nativeToScVal(REFUNDED,   { type: "i128" }),
  };
  if (cancelledAt !== undefined) fields["cancelled_at"] = cancelledAt;

  return xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(key), val,
      })),
  );
}

describe("StreamClient.get — parseStream field mapping", () => {
  let rpc: ReturnType<typeof mockRpc>;

  beforeEach(() => { rpc = mockRpc(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("maps every field for an active (non-cancelled) stream", async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulation(streamValue(undefined)),
    );

    await expect(new StreamClient(clientOptions).get()).resolves.toEqual({
      sender:        PAYER,
      recipient:     PAYEE,
      token:         TOKEN,
      ratePerSecond: RATE,
      start:         START,
      stop:          STOP,
      cancellable:   true,
      deposited:     DEPOSITED,
      withdrawn:     WITHDRAWN,
      refunded:      REFUNDED,
      cancelledAt:   null,
    });
  });

  it("sets cancelledAt to null when the field is absent", async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulation(streamValue(undefined)),
    );
    const stream = await new StreamClient(clientOptions).get();
    expect(stream.cancelledAt).toBeNull();
  });

  it("sets cancelledAt to null when the field is scvVoid", async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulation(streamValue(xdr.ScVal.scvVoid())),
    );
    const stream = await new StreamClient(clientOptions).get();
    expect(stream.cancelledAt).toBeNull();
  });

  it("parses cancelledAt as a bigint when the field is present", async () => {
    const cancelledAt = 1_700_001_800n;
    rpc.simulateTransaction.mockResolvedValue(
      simulation(streamValue(nativeToScVal(cancelledAt, { type: "u64" }))),
    );
    const stream = await new StreamClient(clientOptions).get();
    expect(stream.cancelledAt).toBe(cancelledAt);
  });

  it("calls the 'get' entry point with no arguments on the right contract", async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulation(streamValue(undefined)),
    );

    await new StreamClient(clientOptions).get();

    expect(rpc.getAccount).toHaveBeenCalledWith(PAYER);
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    const transaction = rpc.simulateTransaction.mock.calls[0]![0];
    const invocation = contractInvocation(transaction);
    expect(Address.fromScAddress(invocation.contractAddress).toString()).toBe(CONTRACT);
    expect(invocation.functionName.toString()).toBe("get");
    expect(invocation.args).toEqual([]);
  });

  it("rejects a cancelledAt field that is not an integer", async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulation(streamValue(nativeToScVal("not-a-timestamp", { type: "string" }))),
    );
    await expect(new StreamClient(clientOptions).get()).rejects.toThrow(ValidationError);
    await expect(new StreamClient(clientOptions).get()).rejects.toThrow(/cancelled_at/);
  });
});
