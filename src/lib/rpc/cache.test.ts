import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRpcCache, cacheKeyFor, resetRpcCache } from "./cache";
import { invokeWithPolicy } from "./connection";
import { setRpcLogger } from "./logger";
import { cacheTtlFor, UNCACHEABLE_METHODS } from "./methods";
import { setRpcRetryConfig } from "./retry";

afterEach(() => {
  resetRpcCache();
  setRpcLogger(null);
  setRpcRetryConfig(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MemoryRpcCache", () => {
  it("expires entries after TTL and evicts oldest when over the size bound", () => {
    let now = 1_000;
    const cache = new MemoryRpcCache(2, () => now);
    cache.set("a", 1, 50);
    cache.set("b", 2, 50);
    expect(cache.get("a")?.value).toBe(1);
    cache.set("c", 3, 50);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size).toBe(2);
    now = 1_060;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
  });

  it("builds a stable key from PublicKey-like args", () => {
    expect(cacheKeyFor("getAccountInfo", [{ toBase58: () => "Addr111" }, { commitment: "confirmed" }]))
      .toBe(cacheKeyFor("getAccountInfo", [{ toBase58: () => "Addr111" }, { commitment: "confirmed" }]));
    expect(cacheKeyFor("getAccountInfo", [{ toBase58: () => "Addr111" }]))
      .not.toBe(cacheKeyFor("getAccountInfo", [{ toBase58: () => "Addr222" }]));
  });
});

describe("invokeWithPolicy cache", () => {
  it("dedupes in-flight reads and then serves TTL hits", async () => {
    let resolveFirst: (value: { owner: string }) => void = () => undefined;
    const primary = vi.fn(() => new Promise<{ owner: string }>((resolve) => {
      resolveFirst = resolve;
    }));
    const first = invokeWithPolicy({
      method: "getAccountInfo",
      args: ["acct"],
      primary,
      primaryId: "solami",
    });
    const second = invokeWithPolicy({
      method: "getAccountInfo",
      args: ["acct"],
      primary,
      primaryId: "solami",
    });
    expect(primary).toHaveBeenCalledOnce();
    resolveFirst({ owner: "shared" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ value: { owner: "shared" }, cacheHit: false }),
      expect.objectContaining({ value: { owner: "shared" }, cacheHit: false }),
    ]);
    const cached = await invokeWithPolicy({
      method: "getAccountInfo",
      args: ["acct"],
      primary,
      primaryId: "solami",
    });
    expect(cached).toMatchObject({ value: { owner: "shared" }, cacheHit: true });
    expect(primary).toHaveBeenCalledOnce();
  });

  it("refetches after TTL expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
    const primary = vi.fn(async () => ({ owner: "fresh" }));
    await invokeWithPolicy({ method: "getAccountInfo", args: ["acct"], primary, primaryId: "solami" });
    vi.advanceTimersByTime(5_001);
    await invokeWithPolicy({ method: "getAccountInfo", args: ["acct"], primary, primaryId: "solami" });
    expect(primary).toHaveBeenCalledTimes(2);
  });

  it("does not cache uncacheable methods", async () => {
    const primary = vi.fn(async () => ({ blockhash: "h1" }));
    await invokeWithPolicy({ method: "getLatestBlockhash", args: [], primary, primaryId: "solami" });
    await invokeWithPolicy({ method: "getLatestBlockhash", args: [], primary, primaryId: "solami" });
    expect(primary).toHaveBeenCalledTimes(2);
    expect(cacheTtlFor("simulateTransaction")).toBeNull();
    expect(cacheTtlFor("sendRawTransaction")).toBeNull();
    expect(cacheTtlFor("getBlockHeight")).toBeNull();
    expect(cacheTtlFor("getParsedTransaction", [{ commitment: "processed" }])).toBeNull();
    expect(cacheTtlFor("getParsedTransaction", [{ commitment: "finalized" }])).toBe(60_000);
    expect(UNCACHEABLE_METHODS.has("confirmTransaction")).toBe(true);
  });

  it("does not cache when args are omitted (history invoke path)", async () => {
    const primary = vi.fn(async () => ({ slot: 1 }));
    await invokeWithPolicy({ method: "getParsedTransaction", primary, primaryId: "solami" });
    await invokeWithPolicy({ method: "getParsedTransaction", primary, primaryId: "solami" });
    expect(primary).toHaveBeenCalledTimes(2);
  });
});
