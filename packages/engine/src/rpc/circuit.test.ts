import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPrimaryCircuitOpen,
  resetRpcCircuit,
  setRpcCircuitClock,
  setRpcCircuitConfig,
} from "./circuit";
import { invokeWithPolicy } from "./connection";
import { RpcHttpError } from "./errors";
import { setRpcLogger } from "./logger";
import { setRpcRetryConfig } from "./retry";
import { resetRpcCache } from "./cache";
import type { RpcLogEvent } from "./types";

afterEach(() => {
  resetRpcCache();
  resetRpcCircuit();
  setRpcLogger(null);
  setRpcRetryConfig(null);
  vi.restoreAllMocks();
});

describe("RPC primary circuit breaker", () => {
  it("skips a lapsed-plan primary on the next call and does not log keys or URLs", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    const events: RpcLogEvent[] = [];
    setRpcLogger((event) => events.push(event));
    const primary = vi.fn(async () => {
      throw new RpcHttpError(401, "RPC HTTP 401");
    });
    const fallback = vi.fn(async () => ({ owner: "helius" }));
    const first = await invokeWithPolicy({
      method: "getAccountInfo",
      primary,
      fallback,
      primaryId: "solami",
      fallbackId: "default",
    });
    expect(first).toMatchObject({ servedBy: "default", errorKind: "auth", reason: "primary-error" });
    expect(isPrimaryCircuitOpen("solami")).toBe(true);

    const second = await invokeWithPolicy({
      method: "getAccountInfo",
      primary,
      fallback,
      primaryId: "solami",
      fallbackId: "default",
    });
    expect(second).toMatchObject({ servedBy: "default", reason: "circuit-open" });
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(events)).not.toMatch(/api_key|https?:\/\/|solami\.dev|helius/i);
  });

  it("retries the primary after the short auth cooldown", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    setRpcCircuitConfig({ authCooldownMs: 1_000 });
    let now = 1_000;
    setRpcCircuitClock(() => now);
    const primary = vi.fn()
      .mockRejectedValueOnce(new RpcHttpError(403, "RPC HTTP 403"))
      .mockResolvedValueOnce({ owner: "solami" });
    const fallback = vi.fn(async () => ({ owner: "helius" }));
    await invokeWithPolicy({
      method: "getAccountInfo",
      primary,
      fallback,
      primaryId: "solami",
      fallbackId: "default",
    });
    now = 2_001;
    const recovered = await invokeWithPolicy({
      method: "getAccountInfo",
      primary,
      fallback,
      primaryId: "solami",
      fallbackId: "default",
    });
    expect(recovered).toMatchObject({ value: { owner: "solami" }, servedBy: "solami", fallback: false });
    expect(primary).toHaveBeenCalledTimes(2);
  });

  it("opens on rate-limit after the primary is exhausted", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    const primary = vi.fn(async () => {
      throw new Error("RPC -32005: Rate limited");
    });
    const fallback = vi.fn(async () => ({ owner: "helius" }));
    await invokeWithPolicy({
      method: "sendRawTransaction",
      primary,
      fallback,
      primaryId: "solami",
      fallbackId: "default",
    });
    await invokeWithPolicy({
      method: "sendRawTransaction",
      primary,
      fallback,
      primaryId: "solami",
      fallbackId: "default",
    });
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});
