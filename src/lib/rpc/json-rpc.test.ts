import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRpcCache } from "@sofinance/engine/rpc/cache";
import { resetRpcCircuit } from "@sofinance/engine/rpc/circuit";
import { RpcHttpError, RpcUnavailableError } from "@sofinance/engine/rpc/errors";
import { rpcRequest } from "@sofinance/engine/rpc/json-rpc";
import { setRpcLogger } from "@sofinance/engine/rpc/logger";
import { PUBLIC_SOLANA_RPC_URL } from "@sofinance/engine/rpc/providers";
import { setRpcRetryConfig } from "@sofinance/engine/rpc/retry";
import type { RpcLogEvent } from "@sofinance/engine/rpc/types";

const DEDICATED = "https://dedicated.example/rpc";


afterEach(() => {
  resetRpcCache();
  resetRpcCircuit();
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
  it("posts JSON-RPC to the dedicated RPC first and then the public fallback", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    const events: RpcLogEvent[] = [];
    setRpcLogger((event) => events.push(event));
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.startsWith(DEDICATED)) {
        return jsonResponse({}, 503);
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: { owner: "fallback" } } });
    });
    const result = await rpcRequest("getAccountInfo", ["acct", { encoding: "base64" }], {
      env: { SOLANA_RPC_URL: `${DEDICATED}?api-key=k` },
      fetcher,
    });
    expect(result).toEqual({ value: { owner: "fallback" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toContain("api-key=k");
    expect(String(fetcher.mock.calls[1]![0])).toBe(PUBLIC_SOLANA_RPC_URL);
    expect(events.some((event) => event.outcome === "fallback" && event.provider === "default")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/api-key|dedicated\.example|mainnet-beta/);
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
      env: { SOLANA_RPC_URL: `${DEDICATED}?api-key=super-secret` },
      fetcher,
    })).rejects.toBeInstanceOf(RpcUnavailableError);
    await expect(rpcRequest("getAccountInfo", ["acct"], {
      env: { SOLANA_RPC_URL: `${DEDICATED}?api-key=super-secret` },
      fetcher,
    })).rejects.toThrow(/temporarily unavailable/);
  });

  it("falls back 401 from the dedicated RPC onto the public RPC without logging secrets", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    const events: RpcLogEvent[] = [];
    setRpcLogger((event) => events.push(event));
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.startsWith(DEDICATED)) return jsonResponse({}, 401);
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: "sig" });
    });
    await expect(rpcRequest("sendTransaction", ["bytes"], {
      env: { SOLANA_RPC_URL: `${DEDICATED}?api-key=super-secret` },
      fetcher,
    })).resolves.toBe("sig");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.outcome === "fallback" && event.errorKind === "auth")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/api-key|super-secret|dedicated\.example|mainnet-beta/);
  });

  it("falls back HTTP 200 JSON-RPC -32005 onto the public RPC", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).startsWith(DEDICATED)) {
        return jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Rate limited" } });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { value: { owner: "fallback" } } });
    });
    await expect(rpcRequest("getAccountInfo", ["acct"], {
      env: { SOLANA_RPC_URL: `${DEDICATED}?api-key=k` },
      fetcher,
    })).resolves.toEqual({ value: { owner: "fallback" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
