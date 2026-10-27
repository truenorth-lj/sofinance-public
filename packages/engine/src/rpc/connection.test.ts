import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRpcCache } from "./cache";
import { resetRpcCircuit } from "./circuit";
import { classifyRpcError, isRpcStructValidationError, RpcHttpError } from "./errors";
import { setRpcLogger } from "./logger";
import { METHOD_POLICIES, methodAllowsFallback, policyFor } from "./methods";
import { createResilientConnection, invokeWithPolicy, lastRpcCallMetric } from "./connection";
import { setRpcRetryConfig } from "./retry";

const EPOCH_ERROR = new Error("At path: transactionCount -- Expected a number, but received: null");
const PARSED_TX_ERROR = new Error(
  "At path: meta.innerInstructions.0.instructions.0 -- Expected the value to satisfy a union of type | type",
);

function pair() {
  const primary = {
    getEpochInfo: vi.fn(async () => {
      throw EPOCH_ERROR;
    }),
    getParsedTransaction: vi.fn(async () => {
      throw PARSED_TX_ERROR;
    }),
    getAccountInfo: vi.fn(async () => ({ owner: "solami" })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: "solami-hash" })),
    getMultipleAccountsInfo: vi.fn(async () => [{ owner: "solami" }]),
    simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
    sendRawTransaction: vi.fn(async () => {
      throw EPOCH_ERROR;
    }),
    rpcEndpoint: "https://rpc.solami.dev/sol",
  };
  const fallback = {
    getEpochInfo: vi.fn(async () => ({ epoch: 800, transactionCount: 12 })),
    getParsedTransaction: vi.fn(async () => ({ slot: 1 })),
    getAccountInfo: vi.fn(async () => ({ owner: "default" })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: "default-hash" })),
    getMultipleAccountsInfo: vi.fn(async () => [{ owner: "default" }]),
    simulateTransaction: vi.fn(async () => ({ value: { err: "fallback" } })),
    sendRawTransaction: vi.fn(async () => "fallback-sig"),
    rpcEndpoint: "https://api.mainnet-beta.solana.com",
  };
  return {
    primary,
    fallback,
    connection: createResilientConnection(primary as never, fallback as never),
  };
}

afterEach(() => {
  resetRpcCache();
  resetRpcCircuit();
  setRpcLogger(null);
  setRpcRetryConfig(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("classifyRpcError", () => {
  it("classifies validation, HTTP, empty, rate-limit, timeout, and other", () => {
    expect(classifyRpcError(EPOCH_ERROR)).toBe("validation");
    expect(classifyRpcError(PARSED_TX_ERROR)).toBe("validation");
    expect(isRpcStructValidationError(EPOCH_ERROR)).toBe(true);
    expect(classifyRpcError(new Error("429 rate limited"))).toBe("rate-limit");
    expect(classifyRpcError(new Error("Too many requests for a specific RPC call"))).toBe("rate-limit");
    expect(classifyRpcError(new Error("RPC -32005: Rate limited"))).toBe("rate-limit");
    expect(classifyRpcError(Object.assign(new Error("Rate limited"), { code: -32005 }))).toBe("rate-limit");
    expect(classifyRpcError(new RpcHttpError(401, "RPC HTTP 401"))).toBe("auth");
    expect(classifyRpcError(new RpcHttpError(402, "RPC HTTP 402"))).toBe("auth");
    expect(classifyRpcError(new Error("403 forbidden"))).toBe("auth");
    expect(classifyRpcError(new RpcHttpError(400, "RPC HTTP 400"))).toBe("http-4xx");
    expect(classifyRpcError(new Error("RPC 503 unavailable"))).toBe("http-5xx");
    expect(classifyRpcError(new Error("no transactions"))).toBe("empty");
    expect(classifyRpcError(new Error("Account not found"))).toBe("other");
    const timeout = new Error("fetch failed");
    timeout.name = "TimeoutError";
    expect(classifyRpcError(timeout)).toBe("timeout");
  });
});

describe("METHOD_POLICIES", () => {
  it("falls back reads and sends on auth, 429, 5xx, and timeout; not on generic 400", () => {
    expect(policyFor("sendRawTransaction").fallback).toBe(true);
    expect(methodAllowsFallback("sendRawTransaction", "auth")).toBe(true);
    expect(methodAllowsFallback("sendRawTransaction", "rate-limit")).toBe(true);
    expect(methodAllowsFallback("sendRawTransaction", "validation")).toBe(false);
    expect(methodAllowsFallback("getEpochInfo", "validation")).toBe(true);
    expect(methodAllowsFallback("getEpochInfo", "auth")).toBe(true);
    expect(methodAllowsFallback("getEpochInfo", "http-4xx")).toBe(false);
    expect(methodAllowsFallback("getAccountInfo", "validation")).toBe(true);
    expect(methodAllowsFallback("getAccountInfo", "rate-limit")).toBe(true);
    expect(methodAllowsFallback("getAccountInfo", "auth")).toBe(true);
    expect(methodAllowsFallback("getParsedTransaction", "empty")).toBe(true);
    expect(methodAllowsFallback("simulateTransaction", "rate-limit")).toBe(true);
    expect(methodAllowsFallback("simulateTransaction", "auth")).toBe(true);
    expect(methodAllowsFallback("simulateTransaction", "validation")).toBe(true);
    expect(methodAllowsFallback("getLatestBlockhash", "rate-limit")).toBe(true);
    expect(methodAllowsFallback("confirmTransaction", "timeout")).toBe(true);
    expect(METHOD_POLICIES.sendTransaction?.fallback).toBe(true);
  });
});

describe("invokeWithPolicy", () => {
  beforeEach(() => {
    setRpcRetryConfig({ maxAttempts: 1 });
  });

  it("falls back on empty listing results", async () => {
    const result = await invokeWithPolicy({
      method: "getParsedTransaction",
      primary: async () => null,
      fallback: async () => ({ slot: 9 }),
      primaryId: "solami",
      fallbackId: "default",
    });
    expect(result).toMatchObject({ value: { slot: 9 }, servedBy: "default", fallback: true, errorKind: "empty" });
  });

  it("falls back on 5xx and records the metric", async () => {
    const result = await invokeWithPolicy({
      method: "getAccountInfo",
      primary: async () => {
        throw new Error("502 Bad Gateway");
      },
      fallback: async () => ({ owner: "helius" }),
      primaryId: "solami",
      fallbackId: "default",
    });
    expect(result.servedBy).toBe("default");
    expect(result.errorKind).toBe("http-5xx");
  });

  it("falls back 429 after the primary is exhausted", async () => {
    const result = await invokeWithPolicy({
      method: "getAccountInfo",
      primary: async () => {
        throw new Error("429 rate limited");
      },
      fallback: async () => ({ owner: "default" }),
      primaryId: "solami",
      fallbackId: "default",
    });
    expect(result).toMatchObject({ value: { owner: "default" }, servedBy: "default", fallback: true, errorKind: "rate-limit" });
  });

  it("does not fall back a generic 400 onto the default RPC", async () => {
    await expect(invokeWithPolicy({
      method: "getSlot",
      primary: async () => {
        throw new Error("400 bad request");
      },
      fallback: async () => 9,
      primaryId: "solami",
      fallbackId: "default",
    })).rejects.toThrow(/400/);
  });

  it("falls back 401/403 auth errors onto the default RPC", async () => {
    const result = await invokeWithPolicy({
      method: "getAccountInfo",
      primary: async () => {
        throw new RpcHttpError(401, "RPC HTTP 401");
      },
      fallback: async () => ({ owner: "helius" }),
      primaryId: "solami",
      fallbackId: "default",
    });
    expect(result).toMatchObject({
      value: { owner: "helius" },
      servedBy: "default",
      fallback: true,
      errorKind: "auth",
      reason: "primary-error",
    });
  });

  it("falls back JSON-RPC -32005 rate limits", async () => {
    const result = await invokeWithPolicy({
      method: "getAccountInfo",
      primary: async () => {
        throw Object.assign(new Error("RPC -32005: Rate limited"), { code: -32005 });
      },
      fallback: async () => ({ owner: "helius" }),
      primaryId: "solami",
      fallbackId: "default",
    });
    expect(result).toMatchObject({
      value: { owner: "helius" },
      servedBy: "default",
      errorKind: "rate-limit",
    });
  });
});

describe("createResilientConnection", () => {
  beforeEach(() => {
    setRpcRetryConfig({ maxAttempts: 1 });
  });

  it("falls back getEpochInfo and getParsedTransaction when Solami fails validation", async () => {
    const { connection, fallback, primary } = pair();
    await expect(connection.getEpochInfo("confirmed")).resolves.toEqual({ epoch: 800, transactionCount: 12 });
    await expect(connection.getParsedTransaction("sig")).resolves.toEqual({ slot: 1 });
    expect(primary.getEpochInfo).toHaveBeenCalledOnce();
    expect(fallback.getEpochInfo).toHaveBeenCalledOnce();
    expect(primary.getParsedTransaction).toHaveBeenCalledOnce();
    expect(fallback.getParsedTransaction).toHaveBeenCalledOnce();
    expect(lastRpcCallMetric(connection)?.servedBy).toBe("default");
    expect(lastRpcCallMetric(connection)?.fallback).toBe(true);
  });

  it("keeps successful Solami account reads, blockhashes, and simulation on the primary", async () => {
    const { connection, fallback, primary } = pair();
    await expect(connection.getAccountInfo("x" as never)).resolves.toEqual({ owner: "solami" });
    await expect(connection.getLatestBlockhash()).resolves.toEqual({ blockhash: "solami-hash" });
    await expect(connection.getMultipleAccountsInfo([] as never)).resolves.toEqual([{ owner: "solami" }]);
    await expect(connection.simulateTransaction({} as never)).resolves.toEqual({ value: { err: null } });
    expect(fallback.getAccountInfo).not.toHaveBeenCalled();
    expect(fallback.getLatestBlockhash).not.toHaveBeenCalled();
    expect(fallback.simulateTransaction).not.toHaveBeenCalled();
    expect(primary.getAccountInfo).toHaveBeenCalledOnce();
    expect(lastRpcCallMetric(connection)?.servedBy).toBe("solami");
  });

  it("does not fall back sends on validation errors", async () => {
    const { connection, fallback } = pair();
    await expect(connection.sendRawTransaction(new Uint8Array())).rejects.toThrow(/transactionCount/);
    expect(fallback.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("re-broadcasts sendRawTransaction on the fallback after primary auth failure", async () => {
    const primary = {
      sendRawTransaction: vi.fn(async () => {
        throw new RpcHttpError(403, "RPC HTTP 403");
      }),
    };
    const fallback = { sendRawTransaction: vi.fn(async () => "fallback-sig") };
    const connection = createResilientConnection(primary as never, fallback as never);
    await expect(connection.sendRawTransaction(new Uint8Array())).resolves.toBe("fallback-sig");
    expect(fallback.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("rethrows generic 400 from the primary without send failover", async () => {
    const primary = { getSlot: vi.fn(async () => { throw new Error("400 bad request"); }) };
    const fallback = { getSlot: vi.fn(async () => 9) };
    const connection = createResilientConnection(primary as never, fallback as never);
    await expect(connection.getSlot()).rejects.toThrow(/400/);
    expect(fallback.getSlot).not.toHaveBeenCalled();
  });
});
