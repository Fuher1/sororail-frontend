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

function scValType(val: xdr.ScVal): string {
  return (val as any).type ?? (val as any).switch?.()?.name;
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
    expect(scValType(invocation.args[0]!)).toBe("scvAddress");
    expect(scValType(invocation.args[1]!)).toBe("scvAddress");
    expect(scValType(invocation.args[2]!)).toBe("scvVec");

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
// BatchPayoutClient.executeEqual (Issue #51)
// ---------------------------------------------------------------------------

describe("BatchPayoutClient.executeEqual — guards and execution", () => {
  it("rejects an empty recipient list before accessing RPC", () => {
    const client = new BatchPayoutClient(clientOptions);
    expect(() =>
      client.executeEqual({
        funder: PAYER,
        token: TOKEN,
        recipients: [],
        amountEach: 100n,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      client.executeEqual({
        funder: PAYER,
        token: TOKEN,
        recipients: [],
        amountEach: 100n,
      }),
    ).toThrow("The recipient list is empty.");
    expect(rpc.getAccount).not.toHaveBeenCalled();
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["zero amount", 0n],
    ["negative amount", -1n],
    ["large negative amount", -1_000_000n],
  ] as const)(
    "rejects a %s before accessing RPC",
    (_label, amountEach) => {
      const client = new BatchPayoutClient(clientOptions);
      expect(() =>
        client.executeEqual({
          funder: PAYER,
          token: TOKEN,
          recipients: [PAYEE],
          amountEach,
        }),
      ).toThrow(ValidationError);
      expect(() =>
        client.executeEqual({
          funder: PAYER,
          token: TOKEN,
          recipients: [PAYEE],
          amountEach,
        }),
      ).toThrow("amount must be greater than zero");
      expect(rpc.getAccount).not.toHaveBeenCalled();
      expect(rpc.simulateTransaction).not.toHaveBeenCalled();
    },
  );

  it("distinguishes executeEqual's validation from execute's validation messages", () => {
    const client = new BatchPayoutClient(clientOptions);

    // execute throws "The payment list is empty." whereas executeEqual throws "The recipient list is empty."
    expect(() =>
      client.executeEqual({
        funder: PAYER,
        token: TOKEN,
        recipients: [],
        amountEach: 100n,
      }),
    ).toThrow("The recipient list is empty.");

    expect(() =>
      client.execute({
        funder: PAYER,
        token: TOKEN,
        recipients: [],
      }),
    ).toThrow("The payment list is empty.");

    // execute throws "payment 1 of 1 (to ...)" whereas executeEqual throws "amount must be greater than zero"
    expect(() =>
      client.executeEqual({
        funder: PAYER,
        token: TOKEN,
        recipients: [PAYEE],
        amountEach: 0n,
      }),
    ).toThrow("amount must be greater than zero");

    expect(() =>
      client.execute({
        funder: PAYER,
        token: TOKEN,
        recipients: [{ to: PAYEE, amount: 0n }],
      }),
    ).toThrow(`payment 1 of 1 (to ${PAYEE})`);
  });

  it("rejects non-positive amountEach even with multiple recipients without calling RPC", () => {
    const client = new BatchPayoutClient(clientOptions);
    expect(() =>
      client.executeEqual({
        funder: PAYER,
        token: TOKEN,
        recipients: [PAYEE, RECIPIENT_2],
        amountEach: 0n,
      }),
    ).toThrow(ValidationError);
    expect(rpc.getAccount).not.toHaveBeenCalled();
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

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
    // Four args: funder (addr), token (addr), recipients (vec), amount (i128).
    expect(invocation.args).toHaveLength(4);
    expect(scValType(invocation.args[0]!)).toBe("scvAddress");
    expect(scValType(invocation.args[1]!)).toBe("scvAddress");
    expect(scValType(invocation.args[2]!)).toBe("scvVec");
    expect(scValType(invocation.args[3]!)).toBe("scvI128");

    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
    const result = await call.simulate();
    expect(result).toEqual({ count: 2, total: 200n });
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// BatchPayoutClient.preview (Issue #52)
// ---------------------------------------------------------------------------

describe("BatchPayoutClient.preview — re-runs validate() before issuing read call", () => {
  it("rejects an empty payment list before accessing RPC", () => {
    const client = new BatchPayoutClient(clientOptions);
    expect(() => client.preview([])).toThrow(ValidationError);
    expect(() => client.preview([])).toThrow("The payment list is empty.");
    expect(rpc.getAccount).not.toHaveBeenCalled();
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["zero amount", 0n],
    ["negative amount", -1n],
    ["large negative amount", -50_000n],
  ] as const)(
    "re-runs validate() and rejects a single payment with %s before accessing RPC",
    (_label, amount) => {
      const client = new BatchPayoutClient(clientOptions);
      expect(() => client.preview([{ to: PAYEE, amount }])).toThrow(ValidationError);
      expect(() => client.preview([{ to: PAYEE, amount }])).toThrow(
        `payment 1 of 1 (to ${PAYEE})`,
      );
      expect(rpc.getAccount).not.toHaveBeenCalled();
      expect(rpc.simulateTransaction).not.toHaveBeenCalled();
    },
  );

  it("re-runs validate() and identifies offending payment in a multi-payment list before RPC", () => {
    const client = new BatchPayoutClient(clientOptions);
    const recipients = [PAYMENT_1, { to: RECIPIENT_2, amount: 0n }];
    expect(() => client.preview(recipients)).toThrow(ValidationError);
    expect(() => client.preview(recipients)).toThrow(
      `payment 2 of 2 (to ${RECIPIENT_2})`,
    );
    expect(rpc.getAccount).not.toHaveBeenCalled();
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it("calls preview on-chain and decodes the Receipt", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(receiptValue(1, 1_000n)));
    const result = await new BatchPayoutClient(clientOptions).preview([PAYMENT_1]);
    expect(result).toEqual({ count: 1, total: 1_000n });
    const transaction = rpc.simulateTransaction.mock.calls[0]![0];
    const invocation = contractInvocation(transaction);
    expect(invocation.functionName.toString()).toBe("preview");
    expect(invocation.args).toHaveLength(1);
    expect(scValType(invocation.args[0]!)).toBe("scvVec");
  });

  it("decodes multi-payment preview Receipt correctly", async () => {
    rpc.simulateTransaction.mockResolvedValue(simulation(receiptValue(2, 3_500n)));
    const result = await new BatchPayoutClient(clientOptions).preview([PAYMENT_1, PAYMENT_2]);
    expect(result).toEqual({ count: 2, total: 3_500n });
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
// BatchPayoutClient.chunk (Issue #53)
// ---------------------------------------------------------------------------

describe("BatchPayoutClient.chunk", () => {
  it("returns an empty array for an empty input", () => {
    expect(BatchPayoutClient.chunk([], 10)).toEqual([]);
  });

  it("returns a single batch when recipients fit within the limit", () => {
    const recipients = [PAYMENT_1, PAYMENT_2];
    expect(BatchPayoutClient.chunk(recipients, 10)).toEqual([recipients]);
  });

  it("splits across exact multiples without creating a trailing empty batch", () => {
    const p3 = { to: PAYEE, amount: 300n };
    const p4 = { to: RECIPIENT_2, amount: 400n };
    const recipients = [PAYMENT_1, PAYMENT_2, p3, p4];

    // 4 items with maxRecipients = 2 -> exactly 2 batches of 2
    const batches2 = BatchPayoutClient.chunk(recipients, 2);
    expect(batches2).toHaveLength(2);
    expect(batches2[0]).toEqual([PAYMENT_1, PAYMENT_2]);
    expect(batches2[1]).toEqual([p3, p4]);

    // 4 items with maxRecipients = 4 -> exactly 1 batch of 4
    expect(BatchPayoutClient.chunk(recipients, 4)).toEqual([recipients]);

    // 6 items with maxRecipients = 3 -> exactly 2 batches of 3
    const recipients6 = [...recipients, PAYMENT_1, PAYMENT_2];
    const batches3 = BatchPayoutClient.chunk(recipients6, 3);
    expect(batches3).toHaveLength(2);
    expect(batches3[0]).toEqual([PAYMENT_1, PAYMENT_2, p3]);
    expect(batches3[1]).toEqual([p4, PAYMENT_1, PAYMENT_2]);
  });

  it("splits across remainders properly", () => {
    const p3 = { to: PAYEE, amount: 300n };
    const p4 = { to: RECIPIENT_2, amount: 400n };
    const p5 = { to: PAYEE, amount: 500n };
    const recipients = [PAYMENT_1, PAYMENT_2, p3, p4, p5];

    // 5 items with maxRecipients = 2 -> 3 batches of [2, 2, 1]
    const batches2 = BatchPayoutClient.chunk(recipients, 2);
    expect(batches2).toHaveLength(3);
    expect(batches2[0]).toEqual([PAYMENT_1, PAYMENT_2]);
    expect(batches2[1]).toEqual([p3, p4]);
    expect(batches2[2]).toEqual([p5]);

    // 5 items with maxRecipients = 3 -> 2 batches of [3, 2]
    const batches3 = BatchPayoutClient.chunk(recipients, 3);
    expect(batches3).toHaveLength(2);
    expect(batches3[0]).toEqual([PAYMENT_1, PAYMENT_2, p3]);
    expect(batches3[1]).toEqual([p4, p5]);

    // 7 items with maxRecipients = 3 -> 3 batches of [3, 3, 1]
    const recipients7 = [...recipients, PAYMENT_1, PAYMENT_2];
    const batches7 = BatchPayoutClient.chunk(recipients7, 3);
    expect(batches7).toHaveLength(3);
    expect(batches7[0]).toEqual([PAYMENT_1, PAYMENT_2, p3]);
    expect(batches7[1]).toEqual([p4, p5, PAYMENT_1]);
    expect(batches7[2]).toEqual([PAYMENT_2]);
  });

  it("creates a batch per recipient when maxRecipients is 1", () => {
    const recipients = [PAYMENT_1, PAYMENT_2];
    const batches = BatchPayoutClient.chunk(recipients, 1);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([PAYMENT_1]);
    expect(batches[1]).toEqual([PAYMENT_2]);
  });

  it.each([
    ["zero (0)", 0],
    ["negative (-1)", -1],
    ["large negative (-100)", -100],
    ["fractional (1.5)", 1.5],
    ["fractional (0.5)", 0.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ] as const)(
    "rejects invalid maxRecipients=%s (< 1 or non-integer) with ValidationError",
    (_label, maxRecipients) => {
      expect(() => BatchPayoutClient.chunk([PAYMENT_1], maxRecipients)).toThrow(ValidationError);
      expect(() => BatchPayoutClient.chunk([PAYMENT_1], maxRecipients)).toThrow(
        "maxRecipients must be a whole number of at least 1.",
      );
    },
  );
});
