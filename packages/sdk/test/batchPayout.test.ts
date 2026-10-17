import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BatchPayoutClient } from "../src/clients/batchPayout.js";
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

// A second recipient address for multi-payment tests.
import { StrKey } from "@stellar/stellar-sdk";
const RECIPIENT_2 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 6));

const PAYMENT_1 = { to: PAYEE, amount: 1_000n };
const PAYMENT_2 = { to: RECIPIENT_2, amount: 2_500n };

/**
 * Builds the scvMap the contract returns for a Receipt struct.
 */
function receiptValue(count: number, total: bigint): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    count: nativeToScVal(count, { type: "u32" }),
    total: nativeToScVal(total, { type: "i128" }),
  };
  return xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
}

let rpc: ReturnType<typeof mockRpc>;
beforeEach(() => {
  rpc = mockRpc();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// BatchPayoutClient.execute
// ---------------------------------------------------------------------------

describe("BatchPayoutClient.execute — validate() guards", () => {
  it("rejects an empty recipient list before accessing RPC", () => {
    const client = new BatchPayoutClient(clientOptions);
    expect(() => client.execute({ funder: PAYER, token: TOKEN, recipients: [] }))
      .toThrow(ValidationError);
    expect(() => client.execute({ funder: PAYER, token: TOKEN, recipients: [] }))
      .toThrow("The payment list is empty.");
    expect(rpc.getAccount).not.toHaveBeenCalled();
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["zero amount", 0n],
    ["negative amount", -1n],
  ] as const)(
    "rejects a single payment with a %s before accessing RPC",
    (_label, amount) => {
      const client = new BatchPayoutClient(clientOptions);
      expect(() =>
        client.execute({ funder: PAYER, token: TOKEN, recipients: [{ to: PAYEE, amount }] }),
      ).toThrow(ValidationError);
      expect(rpc.getAccount).not.toHaveBeenCalled();
      expect(rpc.simulateTransaction).not.toHaveBeenCalled();
    },
  );

  it("includes the offending payment's 1-based index and address in the error message", () => {
    // First payment is valid; second has a zero amount.
    const recipients = [PAYMENT_1, { to: RECIPIENT_2, amount: 0n }];
    expect(() =>
      new BatchPayoutClient(clientOptions).execute({ funder: PAYER, token: TOKEN, recipients }),
    ).toThrow(`payment 2 of 2 (to ${RECIPIENT_2})`);
  });

  it("rejects when any payment in a multi-payment list is non-positive", () => {
    const recipients = [PAYMENT_1, { to: RECIPIENT_2, amount: -50n }, PAYMENT_1];
    expect(() =>
      new BatchPayoutClient(clientOptions).execute({ funder: PAYER, token: TOKEN, recipients }),
    ).toThrow(ValidationError);
  });
});

describe("BatchPayoutClient.execute — happy path", () => {
  it("encodes funder, token, and recipients and decodes the Receipt", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(receiptValue(2, 3_500n)));
    const call = await new BatchPayoutClient(clientOptions).execute({
      funder: PAYER,
      token: TOKEN,
      recipients: [PAYMENT_1, PAYMENT_2],
    });

    const invocation = contractInvocation(call);
    expect(Address.fromScAddress(invocation.contractAddress).toString()).toBe(CONTRACT);
    expect(invocation.functionName.toString()).toBe("execute");
    // Three args: funder (address), token (address), recipients (vec).
    expect(invocation.args).toHaveLength(3);
    expect(invocation.args[0]!.switch().name).toBe("scvAddress");
    expect(invocation.args[1]!.switch().name).toBe("scvAddress");
    expect(invocation.args[2]!.switch().name).toBe("scvVec");

    // simulate() should decode the Receipt correctly.
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
    const result = await call.simulate();
    expect(result).toEqual({ count: 2, total: 3_500n });
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("encodes a single-recipient batch", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(receiptValue(1, 1_000n)));
    const call = await new BatchPayoutClient(clientOptions).execute({
      funder: PAYER,
      token: TOKEN,
      recipients: [PAYMENT_1],
    });
    const result = await call.simulate();
    expect(result).toEqual({ count: 1, total: 1_000n });
  });

  it("preserves bigint precision in the Receipt total beyond Number.MAX_SAFE_INTEGER", async () => {
    const largeTotal = 9_007_199_254_740_993n;
    rpc.simulateTransaction.mockResolvedValue(simulation(receiptValue(1, largeTotal)));
    const call = await new BatchPayoutClient(clientOptions).execute({
      funder: PAYER,
      token: TOKEN,
      recipients: [{ to: PAYEE, amount: largeTotal }],
    });
    const result = await call.simulate();
    expect(result.total).toBe(largeTotal);
  });

  it("rejects a malformed Receipt (missing struct)", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(xdr.ScVal.scvBool(true)));
    const call = await new BatchPayoutClient(clientOptions).execute({
      funder: PAYER,
      token: TOKEN,
      recipients: [PAYMENT_1],
    });
    await expect(call.simulate()).rejects.toThrow(ValidationError);
    await expect(call.simulate()).rejects.toThrow(/Receipt/);
  });
});

// ---------------------------------------------------------------------------
// BatchPayoutClient.executeEqual
// ---------------------------------------------------------------------------

describe("BatchPayoutClient.executeEqual — guards", () => {
  it("rejects an empty recipient list before accessing RPC", () => {
    expect(() =>
      new BatchPayoutClient(clientOptions).executeEqual({
        funder: PAYER, token: TOKEN, recipients: [], amountEach: 100n,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      new BatchPayoutClient(clientOptions).executeEqual({
        funder: PAYER, token: TOKEN, recipients: [], amountEach: 100n,
      }),
    ).toThrow("The recipient list is empty.");
    expect(rpc.getAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["zero amount", 0n],
    ["negative amount", -1n],
  ] as const)(
    "rejects a %s before accessing RPC",
    (_label, amountEach) => {
      expect(() =>
        new BatchPayoutClient(clientOptions).executeEqual({
          funder: PAYER, token: TOKEN, recipients: [PAYEE], amountEach,
        }),
      ).toThrow(ValidationError);
      expect(rpc.getAccount).not.toHaveBeenCalled();
    },
  );

  it("encodes funder, token, recipients vec, and amount, then decodes Receipt", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(receiptValue(2, 200n)));
    const call = await new BatchPayoutClient(clientOptions).executeEqual({
      funder: PAYER,
      token: TOKEN,
      recipients: [PAYEE, RECIPIENT_2],
      amountEach: 100n,
    });
    const invocation = contractInvocation(call);
    expect(invocation.functionName.toString()).toBe("execute_equal");
    // Four args: funder, token, recipients vec, amount.
    expect(invocation.args).toHaveLength(4);
    expect(invocation.args[3]!.switch().name).toBe("scvI128");
    const result = await call.simulate();
    expect(result).toEqual({ count: 2, total: 200n });
  });
});

// ---------------------------------------------------------------------------
// BatchPayoutClient.preview
// ---------------------------------------------------------------------------

describe("BatchPayoutClient.preview", () => {
  it("rejects an empty list before accessing RPC", () => {
    expect(() => new BatchPayoutClient(clientOptions).preview([])).toThrow(ValidationError);
    expect(() => new BatchPayoutClient(clientOptions).preview([])).toThrow(
      "The payment list is empty.",
    );
    expect(rpc.getAccount).not.toHaveBeenCalled();
  });

  it("calls preview on-chain and decodes the Receipt", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(receiptValue(1, 1_000n)));
    const result = await new BatchPayoutClient(clientOptions).preview([PAYMENT_1]);
    expect(result).toEqual({ count: 1, total: 1_000n });
    const transaction = rpc.simulateTransaction.mock.calls[0]![0];
    const invocation = contractInvocation(transaction);
    expect(invocation.functionName.toString()).toBe("preview");
    expect(invocation.args).toHaveLength(1);
    expect(invocation.args[0]!.switch().name).toBe("scvVec");
  });
});

// ---------------------------------------------------------------------------
// BatchPayoutClient.maxRecipients
// ---------------------------------------------------------------------------

describe("BatchPayoutClient.maxRecipients", () => {
  it("decodes a u32 value as a number", async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulation(nativeToScVal(50, { type: "u32" })),
    );
    const result = await new BatchPayoutClient(clientOptions).maxRecipients();
    expect(typeof result).toBe("number");
    expect(result).toBe(50);
    const transaction = rpc.simulateTransaction.mock.calls[0]![0];
    expect(contractInvocation(transaction).functionName.toString()).toBe("max_recipients");
    expect(contractInvocation(transaction).args).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BatchPayoutClient.chunk (pure, no RPC)
// ---------------------------------------------------------------------------

describe("BatchPayoutClient.chunk", () => {
  it("returns an empty array for an empty input", () => {
    expect(BatchPayoutClient.chunk([], 10)).toEqual([]);
  });

  it("returns a single batch when recipients fit within the limit", () => {
    const recipients = [PAYMENT_1, PAYMENT_2];
    expect(BatchPayoutClient.chunk(recipients, 10)).toEqual([recipients]);
  });

  it("splits exactly on the boundary", () => {
    const recipients = [PAYMENT_1, PAYMENT_2, PAYMENT_1];
    const batches = BatchPayoutClient.chunk(recipients, 2);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([PAYMENT_1, PAYMENT_2]);
    expect(batches[1]).toEqual([PAYMENT_1]);
  });

  it("creates a batch per recipient when maxRecipients is 1", () => {
    const recipients = [PAYMENT_1, PAYMENT_2];
    const batches = BatchPayoutClient.chunk(recipients, 1);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([PAYMENT_1]);
    expect(batches[1]).toEqual([PAYMENT_2]);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ] as const)(
    "rejects maxRecipients=%s",
    (_label, maxRecipients) => {
      expect(() => BatchPayoutClient.chunk([PAYMENT_1], maxRecipients)).toThrow(ValidationError);
      expect(() => BatchPayoutClient.chunk([PAYMENT_1], maxRecipients)).toThrow(
        "maxRecipients must be a whole number of at least 1.",
      );
    },
  );
});
