import type { BaseClient } from "../clients/base.js";

/**
 * #77 — Batch/multi-get helper for reading several positions in fewer round
 * trips. Each `read()` call is an independent Soroban simulation, so they
 * can run concurrently rather than sequentially. The SDK previously had no
 * helper for this, forcing the multi-position UI to issue one full client
 * construction + `getAccount` + simulate per position, sequentially.
 *
 * @example
 * ```ts
 * const values = await batchRead([
 *   { client: streamClient, method: "get_balance" },
 *   { client: vestingClient, method: "get_vested" },
 *   { client: escrowClient, method: "get_balance" },
 * ]);
 * // values[0] → the first successful result, in input order
 * // if any read rejects, the whole batch rejects
 * ```
 */
export async function batchRead<T>(
  calls: Array<{
    client: BaseClient;
    method: string;
    args?: unknown[];
  }>,
): Promise<T[]> {
  return Promise.all(
    calls.map(async ({ client, method, args = [] }) => {
      const target = client as unknown as Record<string, (...params: unknown[]) => unknown>;
      if (typeof target[method] === "function") {
        return target[method](...args) as Promise<T>;
      }
      if (typeof target["read"] === "function") {
        const res = await target["read"](method, ...args);
        if (
          res &&
          typeof res === "object" &&
          "simulate" in res &&
          typeof (res as { simulate: unknown }).simulate === "function"
        ) {
          return (res as { simulate: () => Promise<T> }).simulate();
        }
        return res as T;
      }
      throw new Error(`Method "${method}" not found on client.`);
    }),
  );
}

/**
 * Returns one settled result per item in input order. Successful reads keep
 * their values, while failed reads retain their rejection reasons so callers
 * can render partial success without losing track of which item failed.
 */
export async function batchReadSafe<T>(
  calls: Array<{
    client: BaseClient;
    method: string;
    args?: unknown[];
  }>,
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(
    calls.map(async ({ client, method, args = [] }) => {
      const target = client as unknown as Record<string, (...params: unknown[]) => unknown>;
      if (typeof target[method] === "function") {
        return target[method](...args) as Promise<T>;
      }
      if (typeof target["read"] === "function") {
        const res = await target["read"](method, ...args);
        if (
          res &&
          typeof res === "object" &&
          "simulate" in res &&
          typeof (res as { simulate: unknown }).simulate === "function"
        ) {
          return (res as { simulate: () => Promise<T> }).simulate();
        }
        return res as T;
      }
      throw new Error(`Method "${method}" not found on client.`);
    }),
  );
}
