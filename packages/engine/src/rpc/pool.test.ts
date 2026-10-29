import type { Connection } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRpcCache } from "./cache";
import { isPrimaryCircuitOpen, resetRpcCircuit, setRpcCircuitClock } from "./circuit";
import { createPooledConnection, lastRpcCallMetric } from "./connection";
import { RpcHttpError } from "./errors";
import { rpcRequest } from "./json-rpc";
import { formatRpcLog, setRpcLogger } from "./logger";
import { parseRpcProviders, resolveRpcPool, routeMembers, type RpcPool, type RpcPoolMember } from "./pool";
import { resetRpcRateLimiters } from "./rate-limit";
import { resetReadRotation } from "./select";
import { setRpcRetryConfig } from "./retry";
import type { RpcLogEvent } from "./types";
import { PUBLIC_SOLANA_RPC_URL, RETIRED_RPC_HOSTS } from "./urls";

const ENV = {
  SOLANA_RPC_URL: "https://helius.example/?api-key=SECRET_H",
  ALCHEMY_RPC_URL: "https://alchemy.example/v2/SECRET_A",
  QUICKNODE_RPC_URL: "https://qn.example/SECRET_Q/",
};

function providers(list: unknown[], env: Record<string, string> = ENV): RpcPool {
  return parseRpcProviders(JSON.stringify(list), env);
}

const names = (members: readonly RpcPoolMember[]) => members.map((m) => m.name ?? m.key);

type Behaviour = (method: string, args: unknown[]) => unknown;

/** Fake web3.js connections keyed by endpoint; records which provider served each call. */
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
      const behaviour = behaviours[name];
      conn = new Proxy({ rpcEndpoint: member.endpoint } as Record<string, unknown>, {
        get(target, prop) {
          if (prop in target) return target[prop as string];
          return async (...args: unknown[]) => {
            served.push(`${name}:${String(prop)}`);
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

let events: RpcLogEvent[] = [];
beforeEach(() => {
  events = [];
  setRpcLogger((event) => events.push(event));
  setRpcRetryConfig({ maxAttempts: 1 });
});
afterEach(() => {
  resetRpcCache();
  resetRpcCircuit();
  resetRpcRateLimiters();
  resetReadRotation();
  setRpcLogger(null);
  setRpcRetryConfig(null);
  vi.restoreAllMocks();
});

describe("SOLANA_RPC_PROVIDERS parsing", () => {
  it("resolves $VAR references, skips unset ones, and keeps sends on the legacy pair by default", () => {
    const pool = providers([
      { name: "helius", url: "$SOLANA_RPC_URL", rps: 8 },
      { name: "alchemy", url: "$ALCHEMY_RPC_URL", rps: 12, exclude: ["getProgramAccounts"] },
      { name: "triton", url: "$TRITON_RPC_URL" },
      { name: "public", url: PUBLIC_SOLANA_RPC_URL, rps: 3 },
    ]);
    expect(pool.source).toBe("env");
    expect(pool.sticky).toBe(true);
    expect(names(pool.read)).toEqual(["helius", "alchemy", "public"]);
    expect(pool.read[1]).toMatchObject({ endpoint: ENV.ALCHEMY_RPC_URL, rps: 12, excludeMethods: ["getProgramAccounts"], key: "pool:alchemy" });
    // No provider flagged for transactions: sends keep the exact legacy SOLANA_RPC_URL → public pair.
    expect(pool.transaction.map((m) => [m.endpoint, m.key, m.maxConcurrency, m.trackHealth])).toEqual([
      [ENV.SOLANA_RPC_URL, "default", 6, true],
      [PUBLIC_SOLANA_RPC_URL, "default:fallback", null, false],
    ]);
  });

  it("uses only providers flagged for transactions, in listed order", () => {
    const pool = providers([
      { name: "alchemy", url: "$ALCHEMY_RPC_URL" },
      { name: "helius", url: "$SOLANA_RPC_URL", transactions: true },
      { name: "qn", url: "$QUICKNODE_RPC_URL", reads: false, transactions: true },
    ]);
    expect(names(pool.transaction)).toEqual(["helius", "qn"]);
    expect(names(pool.read)).toEqual(["alchemy", "helius"]);
  });

  it("skips retired vendor hosts (literal or via $VAR) like an unset $VAR", () => {
    const retired = `https://rpc.${RETIRED_RPC_HOSTS[0]}/sol?api_key=k`;
    const pool = providers([
      { name: "old", url: "$OLD_RPC_URL" },
      { name: "literal", url: retired },
      { name: "helius", url: "$SOLANA_RPC_URL" },
    ], { ...ENV, OLD_RPC_URL: retired });
    expect(names(pool.read)).toEqual(["helius"]);
    expect(pool.read.some((m) => m.endpoint.includes(RETIRED_RPC_HOSTS[0]!))).toBe(false);
  });

  it.each([
    ["not json", "must be a JSON array"],
    ["[]", "non-empty"],
    [JSON.stringify([{ url: "https://x.example" }]), "short name"],
    [JSON.stringify([{ name: "a", url: "https://x.example", rps: -1 }]), "rps must be a positive number"],
    [JSON.stringify([{ name: "a", url: "https://x.example" }, { name: "a", url: "https://y.example" }]), "duplicate"],
    [JSON.stringify([{ name: "a", url: "ftp://x.example" }]), "http(s)"],
    [JSON.stringify([{ name: "a", url: "$NOPE" }]), "no read provider"],
  ])("rejects %s", (raw, message) => {
    expect(() => parseRpcProviders(raw, ENV)).toThrow(message);
  });

  it("falls back to the legacy pool on invalid config with one key-free error line", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = JSON.stringify([{ name: "a", url: "https://secret.example/KEY", rps: "fast" }]);
    const pool = resolveRpcPool({ ...ENV, SOLANA_RPC_PROVIDERS: raw });
    resolveRpcPool({ ...ENV, SOLANA_RPC_PROVIDERS: raw });
    expect(pool.source).toBe("legacy");
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).not.toMatch(/secret|KEY/);
  });
});

describe("routing", () => {
  const pool = () => providers([
    { name: "helius", url: "$SOLANA_RPC_URL", transactions: true },
    { name: "alchemy", url: "$ALCHEMY_RPC_URL", exclude: ["getProgramAccounts", "getTokenLargestAccounts"] },
    { name: "public", url: PUBLIC_SOLANA_RPC_URL, transactions: true },
  ]);

  it("drops providers that exclude a method, matching web3.js names to JSON-RPC names", () => {
    const p = pool();
    expect(names(routeMembers(p, "read", "getProgramAccounts"))).toEqual(["helius", "public"]);
    expect(names(routeMembers(p, "read", "getParsedProgramAccounts"))).toEqual(["helius", "public"]);
    expect(names(routeMembers(p, "read", "_rpcRequest", ["getProgramAccounts", []]))).toEqual(["helius", "public"]);
    expect(names(routeMembers(p, "read", "getAccountInfo"))).toEqual(["helius", "alchemy", "public"]);
  });

  it("sends and slot-context reads use only transaction providers; a read-only connection frees context reads", async () => {
    const p = pool();
    const { served, connectionFor } = fleet(p, { helius: () => { throw new RpcHttpError(503, "RPC HTTP 503"); } });
    const conn = createPooledConnection(p, connectionFor);
    await call(conn, "sendRawTransaction", "tx");
    await call(conn, "getMultipleAccountsInfoAndContext", []);
    expect(served).toEqual([
      "helius:sendRawTransaction", "public:sendRawTransaction",
      "helius:getMultipleAccountsInfoAndContext", "public:getMultipleAccountsInfoAndContext",
    ]);
    served.length = 0;
    resetRpcCircuit();
    const reader = createPooledConnection(p, connectionFor, { readOnly: true });
    await call(reader, "getMultipleAccountsInfoAndContext", []);
    expect(served).toEqual(["helius:getMultipleAccountsInfoAndContext", "alchemy:getMultipleAccountsInfoAndContext"]);
  });
});

describe("proactive rate limiting", () => {
  it("overflows to the next provider when the chosen one's budget is spent, without sending it a request", async () => {
    let now = 0;
    resetRpcRateLimiters(() => now);
    // helius' weight (rps 100) makes it the weighted pick every time; burst 1 spends its budget at once.
    const p = providers([
      { name: "helius", url: "$SOLANA_RPC_URL", rps: 100, burst: 1 },
      { name: "alchemy", url: "$ALCHEMY_RPC_URL", rps: 1, burst: 1 },
    ]);
    const { served, connectionFor } = fleet(p);
    // Separate connections (requests), so stickiness does not apply.
    for (let i = 0; i < 2; i += 1) await call(createPooledConnection(p, connectionFor), "getBalance", `w${i}`);
    expect(served).toEqual(["helius:getBalance", "alchemy:getBalance"]);
    const overflowed = events.filter((e) => e.reason === "local-rate-limit");
    expect(overflowed.map((e) => [e.via, e.outcome])).toEqual([["alchemy", "ok"]]);
    now += 1_000; // budget refilled: back to the weighted pick
    await call(createPooledConnection(p, connectionFor), "getBalance", "w3");
    expect(served.at(-1)).toBe("helius:getBalance");
  });

  it("waits for budget instead of overflowing when no other provider has any", async () => {
    const p = providers([
      { name: "helius", url: "$SOLANA_RPC_URL", rps: 20, burst: 1 },
      { name: "alchemy", url: "$ALCHEMY_RPC_URL", rps: 20, burst: 1 },
    ]);
    const { served, connectionFor } = fleet(p);
    const started = Date.now();
    for (let i = 0; i < 4; i += 1) await call(createPooledConnection(p, connectionFor), "getBalance", `w${i}`);
    expect(served).toHaveLength(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });
});

describe("failover and health", () => {
  it("moves a 429'd read to the next provider, parks the first for its Retry-After, and logs why", async () => {
    let now = 1_000_000;
    setRpcCircuitClock(() => now);
    // helius' weight makes it the weighted pick whenever it is healthy.
    const p = providers([{ name: "helius", url: "$SOLANA_RPC_URL", rps: 100 }, { name: "alchemy", url: "$ALCHEMY_RPC_URL", rps: 1, burst: 10 }]);
    let heliusLimited = true;
    const { served, connectionFor } = fleet(p, {
      helius: () => { if (heliusLimited) throw new RpcHttpError(429, "RPC HTTP 429", 10_000); return { from: "helius" }; },
    });
    await expect(call(createPooledConnection(p, connectionFor), "getBalance", "a")).resolves.toEqual({ from: "alchemy" });
    expect(isPrimaryCircuitOpen("pool:helius")).toBe(true);
    heliusLimited = false;
    now += 5_000; // still inside Retry-After (10 s, honoured up to 30 s): helius is not picked
    await call(createPooledConnection(p, connectionFor), "getBalance", "b");
    now += 6_000;
    await call(createPooledConnection(p, connectionFor), "getBalance", "c");
    expect(served).toEqual(["helius:getBalance", "alchemy:getBalance", "alchemy:getBalance", "helius:getBalance"]);
    const fallbacks = events.filter((e) => e.outcome === "fallback");
    // While parked, helius is ordered last, so the healthy provider serves without a failover.
    expect(fallbacks.map((e) => [e.via, e.errorKind, e.reason])).toEqual([["alchemy", "rate-limit", "primary-error"]]);
    for (const event of events) expect(formatRpcLog(event)).not.toMatch(/SECRET|example/);
  });

  it("walks past several broken providers to the first working one", async () => {
    const p = providers([
      { name: "a", url: "$SOLANA_RPC_URL" },
      { name: "b", url: "$ALCHEMY_RPC_URL" },
      { name: "c", url: "$QUICKNODE_RPC_URL" },
    ]);
    const { served, connectionFor } = fleet(p, {
      a: () => { throw new RpcHttpError(401, "RPC HTTP 401"); },
      b: () => { throw new RpcHttpError(502, "RPC HTTP 502"); },
    });
    const conn = createPooledConnection(p, connectionFor);
    await expect(call(conn, "getBalance", "x")).resolves.toEqual({ from: "c" });
    expect(served).toEqual(["a:getBalance", "b:getBalance", "c:getBalance"]);
    expect(lastRpcCallMetric(conn)).toMatchObject({ via: "c", fallback: true, errorKind: "auth" });
  });

  it("does not fail over on errors the method policy keeps (a plain 400)", async () => {
    const p = providers([{ name: "a", url: "$SOLANA_RPC_URL" }, { name: "b", url: "$ALCHEMY_RPC_URL" }]);
    const { served, connectionFor } = fleet(p, { a: () => { throw new RpcHttpError(400, "RPC HTTP 400"); } });
    await expect(call(createPooledConnection(p, connectionFor), "getBalance", "x")).rejects.toThrow("400");
    expect(served).toEqual(["a:getBalance"]);
  });
});

describe("stickiness", () => {
  it("keeps a connection's reads on the provider that served it, even after the first recovers", async () => {
    const p = providers([{ name: "helius", url: "$SOLANA_RPC_URL", rps: 100 }, { name: "alchemy", url: "$ALCHEMY_RPC_URL", rps: 1, burst: 10 }]);
    let fail = true;
    const { served, connectionFor } = fleet(p, {
      helius: () => { if (fail) { fail = false; throw new RpcHttpError(503, "RPC HTTP 503"); } return { from: "helius" }; },
    });
    const conn = createPooledConnection(p, connectionFor);
    await call(conn, "getBalance", "a"); // helius 503 → alchemy
    await call(conn, "getBlockTime", 1); // stays on alchemy
    await call(createPooledConnection(p, connectionFor), "getBalance", "b"); // new request starts at helius
    expect(served).toEqual(["helius:getBalance", "alchemy:getBalance", "alchemy:getBlockTime", "helius:getBalance"]);
  });

  it("a sticky provider waits for its own budget rather than hopping providers mid-request", async () => {
    let now = 0;
    resetRpcRateLimiters(() => now);
    const p = providers([
      { name: "helius", url: "$SOLANA_RPC_URL", rps: 1000, burst: 1 },
      { name: "alchemy", url: "$ALCHEMY_RPC_URL" },
    ]);
    const { served, connectionFor } = fleet(p);
    const conn = createPooledConnection(p, connectionFor);
    await call(conn, "getBalance", "a");
    const second = call(conn, "getBlockTime", 1);
    now += 5;
    await second;
    expect(served).toEqual(["helius:getBalance", "helius:getBlockTime"]);
  });

  it("reads after a slot-context read follow the provider that produced that slot", async () => {
    const p = providers([
      { name: "alchemy", url: "$ALCHEMY_RPC_URL" },
      { name: "helius", url: "$SOLANA_RPC_URL", transactions: true },
    ]);
    const { served, connectionFor } = fleet(p);
    const conn = createPooledConnection(p, connectionFor);
    await call(conn, "getSlot");
    await call(conn, "getBlockTime", 123);
    expect(served).toEqual(["helius:getSlot", "helius:getBlockTime"]);
  });
});

describe("rpcRequest", () => {
  it("routes raw JSON-RPC through the pool and honours exclusions", async () => {
    const env = {
      ...ENV,
      SOLANA_RPC_PROVIDERS: JSON.stringify([
        { name: "alchemy", url: "$ALCHEMY_RPC_URL", exclude: ["getProgramAccounts"] },
        { name: "helius", url: "$SOLANA_RPC_URL" },
      ]),
    };
    const hosts: string[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      hosts.push(new URL(String(url)).host);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), { status: 200 });
    });
    await rpcRequest("getProgramAccounts", ["prog"], { env, fetcher: fetcher as unknown as typeof fetch });
    await rpcRequest("getBalance", ["w"], { env, fetcher: fetcher as unknown as typeof fetch });
    expect(hosts).toEqual(["helius.example", "alchemy.example"]);
  });
});
