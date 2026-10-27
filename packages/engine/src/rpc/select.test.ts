import type { Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRpcCache } from "./cache";
import { notePrimaryFailure, resetRpcCircuit } from "./circuit";
import { createPooledConnection } from "./connection";
import { rpcRequest } from "./json-rpc";
import { setRpcLogger } from "./logger";
import { parseRpcProviders, resolveRpcPool, type RpcPool, type RpcPoolMember } from "./pool";
import { resetRpcRateLimiters } from "./rate-limit";
import { resetReadRotation, spreadsReads, weightedReadOrder } from "./select";

const ENV = {
  SOLANA_RPC_URL: "https://helius.example/k",
  ALCHEMY_RPC_URL: "https://alchemy.example/k",
  SOLAMI_RPC_URL: "https://solami.example/k",
};
// Production shape: rps doubles as the spreading weight.
const PROD = [
  { name: "helius", url: "$SOLANA_RPC_URL", rps: 8 },
  { name: "alchemy", url: "$ALCHEMY_RPC_URL", rps: 12 },
  { name: "solami", url: "$SOLAMI_RPC_URL", rps: 5, exclude: ["getEpochInfo"] },
];
const pool = (list: unknown[] = PROD): RpcPool => parseRpcProviders(JSON.stringify(list), ENV);
const names = (members: readonly RpcPoolMember[]) => members.map((m) => m.name);
const closed = () => false;

function tally(picks: string[]) {
  return picks.reduce<Record<string, number>>((acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }), {});
}

afterEach(() => {
  resetReadRotation();
  resetRpcCircuit();
  resetRpcRateLimiters();
  resetRpcCache();
  setRpcLogger(null);
});

describe("weightedReadOrder", () => {
  it("spreads picks exactly in proportion to rps (8 / 12 / 5)", () => {
    const { read } = pool();
    const picks = Array.from({ length: 250 }, () => weightedReadOrder(read, { isOpen: closed })[0]!.name!);
    expect(tally(picks)).toEqual({ helius: 80, alchemy: 120, solami: 50 });
  });

  it("interleaves smoothly instead of draining one provider first", () => {
    const { read } = pool();
    const picks = Array.from({ length: 25 }, () => weightedReadOrder(read, { isOpen: closed })[0]!.name!);
    expect(picks.slice(0, 5)).toEqual(["alchemy", "helius", "solami", "alchemy", "helius"]);
    const longestRun = Math.max(...picks.map((_, i) => {
      let n = 1;
      while (picks[i + n] === picks[i]) n += 1;
      return n;
    }));
    expect(longestRun).toBeLessThanOrEqual(2);
  });

  it("orders overflow targets by weight after the pick, list order breaking ties", () => {
    const { read } = pool([
      { name: "a", url: "$SOLANA_RPC_URL", rps: 5 },
      { name: "b", url: "$ALCHEMY_RPC_URL", rps: 5 },
      { name: "c", url: "$SOLAMI_RPC_URL", rps: 20 },
    ]);
    expect(names(weightedReadOrder(read, { isOpen: closed }))).toEqual(["c", "a", "b"]);
    expect(names(weightedReadOrder(read, { isOpen: closed }))).toEqual(["a", "c", "b"]);
    expect(names(weightedReadOrder(read, { isOpen: closed }))).toEqual(["c", "a", "b"]);
  });

  it("never picks a provider whose circuit is open; it goes last as a last resort", () => {
    const { read } = pool();
    const isOpen = (key: string) => key === "pool:alchemy";
    const picks = Array.from({ length: 13 }, () => weightedReadOrder(read, { isOpen }));
    expect(picks.every((order) => order.at(-1)!.name === "alchemy")).toBe(true);
    expect(tally(picks.map((order) => order[0]!.name!))).toEqual({ helius: 8, solami: 5 });
  });

  it("keeps list order when every provider is open", () => {
    const { read } = pool();
    expect(names(weightedReadOrder(read, { isOpen: () => true }))).toEqual(["helius", "alchemy", "solami"]);
  });

  it("keeps a preferred provider without advancing the rotation, unless it is unhealthy", () => {
    const { read } = pool();
    expect(weightedReadOrder(read, { preferredKey: "pool:solami", isOpen: closed })[0]!.name).toBe("solami");
    expect(weightedReadOrder(read, { isOpen: closed })[0]!.name).toBe("alchemy"); // rotation untouched
    const isOpen = (key: string) => key === "pool:solami";
    expect(weightedReadOrder(read, { preferredKey: "pool:solami", isOpen })[0]!.name).not.toBe("solami");
  });

  it("only env pools spread reads; the legacy pool keeps its fixed order", () => {
    expect(spreadsReads(pool())).toBe(true);
    expect(spreadsReads(resolveRpcPool({ SOLANA_RPC_URL: ENV.SOLANA_RPC_URL }))).toBe(false);
  });
});

/** Fake connections; `served` records provider:method in call order. */
function fleet(p: RpcPool) {
  const served: string[] = [];
  const cache = new Map<string, Connection>();
  const connectionFor = (member: RpcPoolMember) => {
    const name = p.read.find((m) => m.endpoint === member.endpoint)?.name ?? "legacy";
    if (!cache.has(name)) {
      cache.set(name, new Proxy({ rpcEndpoint: member.endpoint } as Record<string, unknown>, {
        get: (target, prop) => (prop in target ? target[prop as string] : async () => {
          served.push(`${name}:${String(prop)}`);
          return { from: name };
        }),
      }) as unknown as Connection);
    }
    return cache.get(name)!;
  };
  return { served, connectionFor };
}
const call = (conn: Connection, method: string, ...args: unknown[]) =>
  (conn as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);

describe("pooled connections", () => {
  it("spreads new connections across providers by weight", async () => {
    const p = pool();
    const { served, connectionFor } = fleet(p);
    for (let i = 0; i < 25; i += 1) await call(createPooledConnection(p, connectionFor), "getBalance", `w${i}`);
    expect(tally(served.map((s) => s.split(":")[0]!))).toEqual({ helius: 8, alchemy: 12, solami: 5 });
  });

  it("a connection's calls stay on its provider, including concurrent first calls", async () => {
    const p = pool();
    const { served, connectionFor } = fleet(p);
    const conn = createPooledConnection(p, connectionFor);
    await Promise.all([call(conn, "getBalance", "a"), call(conn, "getAccountInfo", "b")]);
    await call(conn, "getBlockTime", 1);
    expect(new Set(served.map((s) => s.split(":")[0]))).toEqual(new Set(["alchemy"]));
  });

  it("skips a provider that excludes the method, for that call only", async () => {
    const p = pool();
    const { served, connectionFor } = fleet(p);
    // Rotation: alchemy, helius, then solami for the third connection.
    for (let i = 0; i < 2; i += 1) await call(createPooledConnection(p, connectionFor), "getBalance", `w${i}`);
    const conn = createPooledConnection(p, connectionFor);
    await call(conn, "getEpochInfo");
    await call(conn, "getBalance", "x");
    expect(served.slice(2)).toEqual(["alchemy:getEpochInfo", "alchemy:getBalance"]);
  });

  it("does not pick a provider with an open circuit", async () => {
    const p = pool();
    notePrimaryFailure("pool:alchemy", "auth");
    const { served, connectionFor } = fleet(p);
    for (let i = 0; i < 13; i += 1) await call(createPooledConnection(p, connectionFor), "getBalance", `w${i}`);
    expect(tally(served.map((s) => s.split(":")[0]!))).toEqual({ helius: 8, solami: 5 });
  });

  it("sends are not spread: no provider is flagged for transactions, so all go to the legacy SOLANA_RPC_URL primary", async () => {
    const p = pool();
    const { served, connectionFor } = fleet(p);
    for (let i = 0; i < 5; i += 1) await call(createPooledConnection(p, connectionFor), "sendRawTransaction", `tx${i}`);
    // The legacy primary is SOLANA_RPC_URL, which the fleet labels "helius" (same endpoint).
    expect(served).toEqual(Array(5).fill("helius:sendRawTransaction"));
  });
});

describe("rpcRequest", () => {
  it("spreads raw JSON-RPC reads by weight", async () => {
    const env = { ...ENV, SOLANA_RPC_PROVIDERS: JSON.stringify(PROD) };
    const hosts: string[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      hosts.push(new URL(String(url)).host.split(".")[0]!);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 });
    });
    for (let i = 0; i < 25; i += 1) await rpcRequest("getBalance", [`w${i}`], { env, fetcher: fetcher as unknown as typeof fetch });
    expect(tally(hosts)).toEqual({ helius: 8, alchemy: 12, solami: 5 });
  });
});
