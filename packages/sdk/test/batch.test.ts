import { describe, expect, it } from "vitest";

import { batchRead, batchReadSafe } from "../src/utils/batch.js";

type TestClient = {
  getValue: () => Promise<number>;
  read?: (method: string) => Promise<number>;
};

function makeClient(value: number | Promise<number> | Error): TestClient {
  return {
    getValue: async () => {
      if (value instanceof Error) throw value;
      return await Promise.resolve(value);
    },
    read: async () => {
      if (value instanceof Error) throw value;
      return await Promise.resolve(value);
    },
  };
}

describe("batchRead", () => {
  it("keeps input order and rejects when any item rejects", async () => {
    const calls = [
      { client: makeClient(10), method: "getValue" },
      { client: makeClient(20), method: "getValue" },
      { client: makeClient(new Error("boom")), method: "getValue" },
      { client: makeClient(40), method: "getValue" },
    ];

    await expect(batchRead<number>(calls)).rejects.toThrow("boom");

    const ordered = [
      { client: makeClient(10), method: "getValue" },
      { client: makeClient(20), method: "getValue" },
      { client: makeClient(30), method: "getValue" },
    ];

    await expect(batchRead<number>(ordered)).resolves.toEqual([10, 20, 30]);
  });
});

describe("batchReadSafe", () => {
  it("reports failed reads per item while still returning successful values", async () => {
    const calls = [
      { client: makeClient(10), method: "getValue" },
      { client: makeClient(new Error("boom")), method: "getValue" },
      { client: makeClient(30), method: "getValue" },
    ];

    await expect(batchReadSafe<number>(calls)).resolves.toEqual([
      { status: "fulfilled", value: 10 },
      { status: "rejected", reason: expect.any(Error) },
      { status: "fulfilled", value: 30 },
    ]);
  });
});
