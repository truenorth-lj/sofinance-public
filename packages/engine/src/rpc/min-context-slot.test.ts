import type { Connection } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRpcCache } from "./cache";
import { resetRpcCircuit } from "./circuit";
import { createPooledConnection } from "./connection";
import { classifyRpcError, isMinContextSlotError, RpcHttpError } from "./errors";
import { rpcRequest } from "./json-rpc";
import { setRpcLogger } from "./logger";
import { parseRpcProviders, resolveRpcPool, type RpcPool, type RpcPoolMember } from "./pool";
import { resetRpcRateLimiters } from "./rate-limit";
import { invokeWithRetries, MIN_CONTEXT_SLOT_RETRY_MS, setRpcRetryConfig } from "./retry";
import { resetReadRotation } from "./select";
import type { RpcLogEvent } from "./types";
import { PUBLIC_SOLANA_RPC_URL } from "./urls";

const ENV = {
  SOLANA_RPC_URL: "https://helius.example/?api-key=SECRET_H",
  ALCHEMY_RPC_URL: "https://alchemy.example/v2/SECRET_A",
};

/** What web3.js throws (SolanaJSONRPCError) when a provider is behind `minContextSlot`. */
const behind = () => Object.assign(
  new Error("failed to get info for accounts Abc: Minimum context slot has not been reached"),
  { code: -32016, data: { contextSlot: 99 } },
);

type Behaviour = (method: string, args: unknown[]) => unknown;

function fleet(pool: RpcPool, behaviours: Record<string, Behaviour> = {}) {
  const served: string[] = [];
  const byEndpoint = new Map<string, Connection>();
  const nameOf = (endpoint: string) =>
    [...pool.read, ...pool.transaction].find((m) => m.endpoint === endpoint)?.name
    ?? (endpoint === PUBLIC_SOLANA_RPC_URL ? "public" : "legacy");
  const connectionFor = (member: RpcPoolMember) => {
    let conn = byEndpoint.get(member.endpoint);
    if (!conn) {
      const name = nameOf(member.endpoint);
      conn = new Proxy({ rpcEndpoint: member.endpoint } as Record<string, unknown>, {
        get(target, prop) {
          if (prop in target) return target[prop as string];
          return async (...args: unknown[]) => {
            served.push(`${name}:${String(prop)}`);
            const behaviour = behaviours[name];
            return behaviour ? behaviour(String(prop), args) : { from: name };
          };
        },
      }) as unknown as Connection;
      byEndpoint.set(member.endpoint, conn);
    }
    return conn;
  };
  return { served, connectionFor };
}

const call = (conn: Connection, method: string, ...args: unknown[]) =>
  (conn as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);

/** Run a promise to completion while fake timers drive the retry waits. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const outcome = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  return outcome;
}

/** Fails the first `n` calls as "behind", then serves. */
const behindFor = (n: number, name: string): Behaviour => {
  let left = n;
  return () => {
    if (left > 0) { left -= 1; throw behind(); }
    return { from: name };
  };
};

let events: RpcLogEvent[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  events = [];
  setRpcLogger((event) => events.push(event));
  setRpcRetryConfig(null);
});
afterEach(() => {
  vi.useRealTimers();
  resetRpcCache();
  resetRpcCircuit();
  resetRpcRateLimiters();
  resetReadRotation();
  setRpcLogger(null);
  setRpcRetryConfig(null);
});

describe("isMinContextSlotError", () => {
  it("matches JSON-RPC -32016 and the provider message, nothing else", () => {
    expect(isMinContextSlotError(behind())).toBe(true);
    expect(isMinContextSlotError(new Error("RPC -32016: Minimum context slot has not been reached"))).toBe(true);
    expect(isMinContextSlotError(new Error("minimum context slot has not been reached"))).toBe(true);
    expect(isMinContextSlotError(new RpcHttpError(429, "RPC HTTP 429"))).toBe(false);
    expect(isMinContextSlotError(Object.assign(new Error("Blockhash not found"), { code: -32002 }))).toBe(false);
  });

  it("does not change how the error is classified (transaction-route policies see it exactly as before)", () => {
    expect(classifyRpcError(behind())).toBe("other");
  });
});

describe("invokeWithRetries", () => {
  it("throws a behind-slot error at once unless the caller opts in", async () => {
    const run = vi.fn(async () => { throw behind(); });
    const { error } = await settle(invokeWithRetries(run, { method: "getMultipleAccountsInfoAndContext", providerId: "default" }));
    expect(isMinContextSlotError(error)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("opted in, waits one slot, then two, and succeeds once the provider catches up", async () => {
    let left = 2;
    const run = vi.fn(async () => { if (left-- > 0) throw behind(); return "ok"; });
    const delays: number[] = [];
    const { value } = await settle(invokeWithRetries(run, {
      method: "getMultipleAccountsInfoAndContext",
      providerId: "default",
      retryMinContextSlot: true,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    }));
    expect(value).toEqual({ value: "ok", retries: 2 });
    expect(delays).toEqual([MIN_CONTEXT_SLOT_RETRY_MS, 2 * MIN_CONTEXT_SLOT_RETRY_MS]);
    expect(events.filter((e) => e.outcome === "retry").map((e) => e.reason)).toEqual(["min-context-slot", "min-context-slot"]);
  });

  it("opted in, still gives up after maxAttempts", async () => {
    const run = vi.fn(async () => { throw behind(); });
    const { error } = await settle(invokeWithRetries(run, {
      method: "getMultipleAccountsInfoAndContext", providerId: "default", retryMinContextSlot: true,
    }));
    expect(isMinContextSlotError(error)).toBe(true);
    expect(run).toHaveBeenCalledTimes(4);
  });
});

describe("pooled connections (SOLANA_RPC_PROVIDERS)", () => {
  // helius' weight makes it the deterministic weighted pick.
  const pool = () => parseRpcProviders(JSON.stringify([
    { name: "helius", url: "$SOLANA_RPC_URL", rps: 100, burst: 50 },
    { name: "alchemy", url: "$ALCHEMY_RPC_URL", rps: 1, burst: 50 },
  ]), ENV);

  it("read-only context read: a 429 fails over to a provider behind the slot, which is waited for instead of failing the request", async () => {
    const p = pool();
    let heliusCalls = 0;
    const { served, connectionFor } = fleet(p, {
      helius: () => { heliusCalls += 1; if (heliusCalls > 1) throw new RpcHttpError(429, "RPC HTTP 429"); return { from: "helius" }; },
      alchemy: behindFor(2, "alchemy"),
    });
    setRpcRetryConfig({ maxAttempts: 4 });
    const reader = createPooledConnection(p, connectionFor, { readOnly: true });
    await settle(call(reader, "getMultipleAccountsInfoAndContext", ["a"], { minContextSlot: 0 }));
    // Second sequential read carries the slot helius returned; helius is now rate limited.
    const { value, error } = await settle(call(reader, "getMultipleAccountsInfoAndContext", ["b"], { minContextSlot: 100 }));
    expect(error).toBeUndefined();
    expect(value).toEqual({ from: "alchemy" });
    expect(served.filter((s) => s.startsWith("alchemy"))).toHaveLength(3);
    expect(events.some((e) => e.outcome === "retry" && e.reason === "min-context-slot" && e.provider === "default")).toBe(true);
  });

  it("plain reads on the read route also wait for a behind provider", async () => {
    const p = pool();
    const { served, connectionFor } = fleet(p, { helius: behindFor(1, "helius") });
    const { value } = await settle(call(createPooledConnection(p, connectionFor), "getBalance", "w", { minContextSlot: 5 }));
    expect(value).toEqual({ from: "helius" });
    expect(served).toEqual(["helius:getBalance", "helius:getBalance"]);
  });

  it("context reads on a normal (transaction-route) connection are unchanged: no wait, no retry", async () => {
    const p = pool();
    const { served, connectionFor } = fleet(p, { helius: () => { throw behind(); } });
    const { error } = await settle(call(createPooledConnection(p, connectionFor), "getMultipleAccountsInfoAndContext", ["a"], { minContextSlot: 9 }));
    expect(isMinContextSlotError(error)).toBe(true);
    expect(served).toEqual(["helius:getMultipleAccountsInfoAndContext"]);
  });

  it.each(["simulateTransaction", "sendRawTransaction", "getLatestBlockhash"])("%s is unchanged: a behind-slot error is thrown at once", async (method) => {
    const p = pool();
    const { served, connectionFor } = fleet(p, { helius: () => { throw behind(); } });
    const reader = createPooledConnection(p, connectionFor, { readOnly: true });
    const { error } = await settle(call(reader, method, "tx", { minContextSlot: 9 }));
    expect(isMinContextSlotError(error)).toBe(true);
    expect(served).toEqual([`helius:${method}`]);
    expect(events.some((e) => e.outcome === "retry")).toBe(false);
  });
});

describe("legacy pool (SOLANA_RPC_PROVIDERS unset)", () => {
  it("is unchanged even on a read-only connection: a behind-slot error is thrown at once", async () => {
    const p = resolveRpcPool({ SOLANA_RPC_URL: ENV.SOLANA_RPC_URL });
    expect(p.source).not.toBe("env");
    const { served, connectionFor } = fleet(p, { legacy: () => { throw behind(); } });
    const reader = createPooledConnection(p, connectionFor, { readOnly: true });
    const { error } = await settle(call(reader, "getMultipleAccountsInfoAndContext", ["a"], { minContextSlot: 9 }));
    expect(isMinContextSlotError(error)).toBe(true);
    expect(served).toHaveLength(1);
  });
});

describe("rpcRequest", () => {
  const rpcError = (code: number, message: string) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }), { status: 200 });
  const ok = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 }), { status: 200 });

  it("waits for a behind provider on read-route methods of an env pool", async () => {
    const env = { ...ENV, SOLANA_RPC_PROVIDERS: JSON.stringify([{ name: "alchemy", url: "$ALCHEMY_RPC_URL" }]) };
    let left = 1;
    const fetcher = vi.fn(async () => (left-- > 0 ? rpcError(-32016, "Minimum context slot has not been reached") : ok()));
    const { value } = await settle(rpcRequest("getBalance", ["w", { minContextSlot: 5 }], { env, fetcher: fetcher as unknown as typeof fetch }));
    expect(value).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("legacy pool: unchanged, thrown at once", async () => {
    const fetcher = vi.fn(async () => rpcError(-32016, "Minimum context slot has not been reached"));
    const { error } = await settle(rpcRequest("getBalance", ["w", { minContextSlot: 5 }], { env: { SOLANA_RPC_URL: ENV.SOLANA_RPC_URL }, fetcher: fetcher as unknown as typeof fetch }));
    expect(isMinContextSlotError(error)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
