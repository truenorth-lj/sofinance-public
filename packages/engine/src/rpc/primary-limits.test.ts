import { afterEach, describe, expect, it } from "vitest";
import { resetRpcCache } from "./cache";
import { DEFAULT_CIRCUIT, isPrimaryCircuitOpen, notePrimaryFailure, resetRpcCircuit } from "./circuit";
import { invokeWithPolicy, PRIMARY_RPC_CONCURRENCY, primaryRpcSlotUsage } from "./connection";
import { setRpcRetryConfig } from "./retry";

afterEach(() => {
  resetRpcCache();
  resetRpcCircuit();
  setRpcRetryConfig(null);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("primary RPC concurrency", () => {
  it("never runs more than PRIMARY_RPC_CONCURRENCY primary calls at once, and completes all of them", async () => {
    let active = 0;
    let peak = 0;
    const calls = Array.from({ length: 40 }, (_, index) => invokeWithPolicy({
      method: "getAccountInfo",
     
      primary: async () => {
        active += 1; peak = Math.max(peak, active);
        await tick();
        active -= 1;
        return { index };
      },
      primaryId: "default",
    } as never));
    const results = await Promise.all(calls);
    expect(results.map((result) => (result.value as { index: number }).index)).toEqual([...Array(40).keys()]);
    expect(peak).toBe(PRIMARY_RPC_CONCURRENCY);
    expect(primaryRpcSlotUsage("default")).toEqual({ active: 0, waiting: 0 });
  });

  it("releases a queued slot when its caller aborts", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holders = Array.from({ length: PRIMARY_RPC_CONCURRENCY }, () => invokeWithPolicy({
      method: "getAccountInfo", primary: async () => { await gate; return 1; }, primaryId: "default",
    } as never));
    const aborter = new AbortController();
    const queued = invokeWithPolicy({
      method: "getAccountInfo", primary: async () => 2, primaryId: "default", signal: aborter.signal,
    } as never);
    await tick();
    expect(primaryRpcSlotUsage("default").waiting).toBe(1);
    aborter.abort(new Error("user left"));
    await expect(queued).rejects.toThrow();
    expect(primaryRpcSlotUsage("default").waiting).toBe(0);
    release();
    await Promise.all(holders);
    expect(primaryRpcSlotUsage("default")).toEqual({ active: 0, waiting: 0 });
  });
});

describe("rate-limited primary with a refusing fallback", () => {
  it("keeps the rate-limit cooldown short", () => {
    expect(DEFAULT_CIRCUIT.rateLimitCooldownMs).toBeLessThanOrEqual(2_000);
  });

  it("tries the primary again when the circuit is open for rate-limit and the fallback refuses", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    notePrimaryFailure("default", "rate-limit");
    expect(isPrimaryCircuitOpen("default")).toBe(true);
    const result = await invokeWithPolicy({
      method: "getAccountInfo",
      primary: async () => ({ owner: "primary" }),
      fallback: async () => { throw new Error("429 Too Many Requests: Connection rate limits exceeded"); },
      primaryId: "default", fallbackId: "default",
    } as never);
    expect(result).toMatchObject({ value: { owner: "primary" }, servedBy: "default", fallback: false });
    expect(isPrimaryCircuitOpen("default")).toBe(false);
  });

  it("does not retry the primary when the circuit is open for auth", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    notePrimaryFailure("default", "auth");
    let primaryCalls = 0;
    await expect(invokeWithPolicy({
      method: "getAccountInfo",
      primary: async () => { primaryCalls += 1; return 1; },
      fallback: async () => { throw new Error("429 Too Many Requests"); },
      primaryId: "default", fallbackId: "default",
    } as never)).rejects.toThrow();
    expect(primaryCalls).toBe(0);
  });
});
