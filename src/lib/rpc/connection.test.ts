import { describe, expect, it, vi } from "vitest";
import { classifyRpcError, isRpcStructValidationError } from "./errors";
import { METHOD_POLICIES, methodAllowsFallback, policyFor } from "./methods";
import { createResilientConnection, invokeWithPolicy, lastRpcCallMetric } from "./connection";

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

describe("classifyRpcError", () => {
  it("classifies validation, HTTP, empty, and other", () => {
    expect(classifyRpcError(EPOCH_ERROR)).toBe("validation");
    expect(classifyRpcError(PARSED_TX_ERROR)).toBe("validation");
    expect(isRpcStructValidationError(EPOCH_ERROR)).toBe(true);
    expect(classifyRpcError(new Error("429 rate limited"))).toBe("http-4xx");
    expect(classifyRpcError(new Error("RPC 503 unavailable"))).toBe("http-5xx");
    expect(classifyRpcError(new Error("no transactions"))).toBe("empty");
    expect(classifyRpcError(new Error("Account not found"))).toBe("other");
  });
});

describe("METHOD_POLICIES", () => {
  it("never falls back sends; falls back getEpochInfo on validation only", () => {
    expect(policyFor("sendRawTransaction").fallback).toBe(false);
    expect(methodAllowsFallback("getEpochInfo", "validation")).toBe(true);
    expect(methodAllowsFallback("getEpochInfo", "http-4xx")).toBe(false);
    expect(methodAllowsFallback("getAccountInfo", "validation")).toBe(true);
    expect(methodAllowsFallback("getParsedTransaction", "empty")).toBe(true);
    expect(METHOD_POLICIES.sendTransaction?.fallback).toBe(false);
  });
});

describe("invokeWithPolicy", () => {
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

  it("does not fall back 429 onto the default RPC", async () => {
    await expect(invokeWithPolicy({
      method: "getSlot",
      primary: async () => {
        throw new Error("429 rate limited");
      },
      fallback: async () => 9,
      primaryId: "solami",
      fallbackId: "default",
    })).rejects.toThrow(/429/);
  });
});

describe("createResilientConnection", () => {
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

  it("does not retry sends on the fallback RPC", async () => {
    const { connection, fallback } = pair();
    await expect(connection.sendRawTransaction(new Uint8Array())).rejects.toThrow(/transactionCount/);
    expect(fallback.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rethrows non-validation 4xx from the primary", async () => {
    const primary = { getSlot: vi.fn(async () => { throw new Error("429 rate limited"); }) };
    const fallback = { getSlot: vi.fn(async () => 9) };
    const connection = createResilientConnection(primary as never, fallback as never);
    await expect(connection.getSlot()).rejects.toThrow(/429/);
    expect(fallback.getSlot).not.toHaveBeenCalled();
  });
});
