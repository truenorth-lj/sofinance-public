import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRpcCache } from "./cache";
import { RpcHttpError, RpcUnavailableError } from "./errors";
import { rpcRequest } from "./json-rpc";
import { setRpcLogger } from "./logger";
import { SOLAMI_RPC_BASE_URL } from "./providers";
import { setRpcRetryConfig } from "./retry";
import type { RpcLogEvent } from "./types";

afterEach(() => {
  resetRpcCache();
  setRpcLogger(null);
  setRpcRetryConfig(null);
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("rpcRequest", () => {
  it("posts JSON-RPC to Solami first and then the dedicated fallback", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    const events: RpcLogEvent[] = [];
    setRpcLogger((event) => events.push(event));
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.startsWith(SOLAMI_RPC_BASE_URL)) {
        return jsonResponse({}, 503);
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: { owner: "dedicated" } } });
    });
    const result = await rpcRequest("getAccountInfo", ["acct", { encoding: "base64" }], {
      env: { SOLAMI_API_KEY: "k", SOLANA_RPC_URL: "https://dedicated.example/rpc" },
      fetcher,
    });
    expect(result).toEqual({ value: { owner: "dedicated" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toContain("api_key=k");
    expect(String(fetcher.mock.calls[1]![0])).toBe("https://dedicated.example/rpc");
    expect(events.some((event) => event.outcome === "fallback" && event.provider === "default")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/api_key|solami\.dev|dedicated\.example/);
  });

  it("parses Retry-After from a 429 and then succeeds on the same provider", async () => {
    vi.useFakeTimers();
    setRpcRetryConfig({ maxAttempts: 2, baseMs: 200, maxDelayMs: 5_000, budgetMs: 8_000 });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "slow down" } }, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse({ result: { ok: true } }));
    const promise = rpcRequest("getAccountInfo", ["acct"], {
      env: { SOLANA_RPC_URL: "https://dedicated.example/rpc" },
      fetcher,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("throws RpcUnavailableError without leaking the endpoint", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    const fetcher = vi.fn(async () => jsonResponse({}, 429, { "Retry-After": "2" }));
    await expect(rpcRequest("getAccountInfo", ["acct"], {
      env: { SOLAMI_API_KEY: "super-secret", SOLANA_RPC_URL: "https://dedicated.example/rpc" },
      fetcher,
    })).rejects.toBeInstanceOf(RpcUnavailableError);
    await expect(rpcRequest("getAccountInfo", ["acct"], {
      env: { SOLAMI_API_KEY: "super-secret", SOLANA_RPC_URL: "https://dedicated.example/rpc" },
      fetcher,
    })).rejects.toThrow(/temporarily unavailable/);
  });

  it("wraps HTTP failures as RpcHttpError", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    const fetcher = vi.fn(async () => jsonResponse({}, 503));
    try {
      await rpcRequest("getSlot", [], { env: { SOLANA_RPC_URL: "https://dedicated.example/rpc" }, fetcher });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RpcUnavailableError);
      expect((error as RpcUnavailableError).cause).toBeInstanceOf(RpcHttpError);
    }
  });
});
