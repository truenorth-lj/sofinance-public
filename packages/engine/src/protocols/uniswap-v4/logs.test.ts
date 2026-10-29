import { describe, expect, it } from "vitest";
import { getLogsChunked, rangeLimitFromError } from "./logs";

describe("getLogsChunked", () => {
  it("parses provider range caps", () => {
    expect(rangeLimitFromError(new Error("query spans 2274956 blocks, only 100000 are allowed"))).toBe(100000n);
    expect(rangeLimitFromError(new Error("eth_getLogs ranges over 10000 blocks are not supported"))).toBe(10000n);
    expect(rangeLimitFromError(new Error("block range too large"))).toBe("range");
    expect(rangeLimitFromError(new Error("execution reverted"))).toBeNull();
  });

  it("splits by the stated cap and covers the range exactly once", async () => {
    const ranges: [bigint, bigint][] = [];
    const logs = await getLogsChunked(async (from, to) => {
      if (to - from + 1n > 100_000n) throw new Error(`only 100000 are allowed`);
      ranges.push([from, to]);
      return [from];
    }, 1n, 250_000n);
    expect(ranges).toEqual([[1n, 100_000n], [100_001n, 200_000n], [200_001n, 250_000n]]);
    expect(logs).toEqual([1n, 100_001n, 200_001n]);
  });

  it("halves when no cap is stated and stops at minSpan or maxRequests", async () => {
    const tooLarge = async () => { throw new Error("block range too large"); };
    await expect(getLogsChunked(tooLarge, 0n, 9_999n)).rejects.toThrow("block range too large");
    await expect(getLogsChunked(async () => [], 0n, 1_000_000n, { maxSpan: 1_000n, maxRequests: 5 })).rejects.toThrow("more than 5 requests");
  });

  it("rethrows unrelated errors and skips empty ranges", async () => {
    await expect(getLogsChunked(async () => { throw new Error("boom"); }, 0n, 10n)).rejects.toThrow("boom");
    expect(await getLogsChunked(async () => [1], 10n, 9n)).toEqual([]);
  });
});
