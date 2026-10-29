/**
 * Proof that the provider pool, with no SOLANA_RPC_PROVIDERS, behaves exactly like engine 0.1.3.
 * Runs every method class × circuit state × provider outcome script through the frozen 0.1.3 code
 * (`test-support/rpc-legacy-connection.ts`) and through the pool, and compares values, errors, log
 * events, call counts per provider, call metrics, and circuit state.
 */
import type { Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createResilientConnection as legacyResilientConnection,
  invokeWithPolicy as legacyInvoke,
  lastRpcCallMetric as legacyLastMetric,
} from "../test-support/rpc-legacy-connection";
import { resetRpcCache } from "./cache";
import { circuitErrorKind, isPrimaryCircuitOpen, notePrimaryFailure, resetRpcCircuit, setRpcCircuitClock } from "./circuit";
import { createPooledConnection, invokeWithPolicy, lastRpcCallMetric } from "./connection";
import { RpcHttpError } from "./errors";
import { setRpcLogger } from "./logger";
import { resolveRpcPool, PRIMARY_RPC_CONCURRENCY } from "./pool";
import { resolveProviderPair } from "./providers";
import { resetRpcRateLimiters } from "./rate-limit";
import { setRpcRetryConfig } from "./retry";
import type { RpcErrorKind, RpcLogEvent, RpcMetricId } from "./types";
import { PUBLIC_SOLANA_RPC_URL } from "./urls";

type Outcome = "ok" | "null" | "429" | "429ra" | "500" | "401" | "timeout" | "validation" | "400";

function outcomeError(outcome: Exclude<Outcome, "ok" | "null">): Error {
  switch (outcome) {
    case "429": return new RpcHttpError(429, "RPC HTTP 429");
    case "429ra": return new RpcHttpError(429, "RPC HTTP 429", 1_500);
    case "500": return new RpcHttpError(500, "RPC HTTP 500");
    case "401": return new RpcHttpError(401, "RPC HTTP 401");
    case "400": return new RpcHttpError(400, "RPC HTTP 400");
    case "timeout": { const error = new Error("request timed out"); error.name = "TimeoutError"; return error; }
    case "validation": return new Error("At path: value -- Expected a number, but received: null");
  }
}

function scripted(name: string, script: readonly Outcome[]) {
  let calls = 0;
  const run = async () => {
    const outcome = script[Math.min(calls, script.length - 1)]!;
    calls += 1;
    if (outcome === "ok") return { from: name, n: calls };
    if (outcome === "null") return null;
    throw outcomeError(outcome);
  };
  return { run, calls: () => calls };
}

const METHODS: Array<{ method: string; args: unknown[] }> = [
  { method: "sendRawTransaction", args: [] },
  { method: "confirmTransaction", args: [] },
  { method: "simulateTransaction", args: [] },
  { method: "getLatestBlockhash", args: [] },
  { method: "getSlot", args: [] },
  { method: "getMultipleAccountsInfoAndContext", args: [] },
  { method: "getAccountInfo", args: ["acct"] },
  { method: "getParsedTransaction", args: ["sig"] },
  { method: "getEpochInfo", args: [] },
  { method: "_rpcRequest", args: ["getTransactionsForAddress", []] },
];
const PRE_STATES: Array<RpcErrorKind | "5xx-once" | null> = [null, "rate-limit", "auth", "5xx-once", "http-5xx"];
const PRIMARY_SCRIPTS: Outcome[][] = [
  ["ok"], ["null"], ["429"], ["429ra"], ["500"], ["401"], ["timeout"], ["validation"], ["400"],
  ["429", "ok"], ["500", "ok"], ["timeout", "ok"], ["429", "429", "ok"],
];
const FALLBACK_SCRIPTS: Array<Outcome[] | null> = [null, ["ok"], ["null"], ["429"], ["500"], ["401"], ["validation"], ["500", "ok"]];

type Observation = {
  outcome: { ok: true; value: unknown } | { ok: false; name: string; message: string };
  events: RpcLogEvent[];
  calls: [number, number];
  metric: unknown;
  circuit: Record<string, { open: boolean; kind: RpcErrorKind | undefined }>;
};

function prepare(primaryId: RpcMetricId, pre: (typeof PRE_STATES)[number]) {
  resetRpcCache();
  resetRpcCircuit();
  resetRpcRateLimiters();
  setRpcCircuitClock(() => 1_000_000);
  setRpcRetryConfig({ maxAttempts: 2, baseMs: 0, maxDelayMs: 0, budgetMs: 10_000 });
  if (pre === "5xx-once") notePrimaryFailure(primaryId, "http-5xx");
  else if (pre === "http-5xx") { notePrimaryFailure(primaryId, "http-5xx"); notePrimaryFailure(primaryId, "http-5xx"); }
  else if (pre) notePrimaryFailure(primaryId, pre);
  const events: RpcLogEvent[] = [];
  setRpcLogger((event) => events.push({ ...event }));
  return events;
}

async function observe(
  events: RpcLogEvent[],
  call: () => Promise<unknown>,
  counters: [() => number, () => number],
  metricOf: () => unknown,
): Promise<Observation> {
  let outcome: Observation["outcome"];
  try {
    outcome = { ok: true, value: await call() };
  } catch (error) {
    outcome = { ok: false, name: (error as Error).name, message: (error as Error).message };
  }
  const circuit: Observation["circuit"] = {};
  for (const id of ["default"]) circuit[id] = { open: isPrimaryCircuitOpen(id), kind: circuitErrorKind(id) };
  return { outcome, events, calls: [counters[0](), counters[1]()], metric: metricOf(), circuit };
}

function fakeConnection(endpoint: string, run: () => Promise<unknown>): Connection {
  const target: Record<string, unknown> = { rpcEndpoint: endpoint };
  for (const { method } of METHODS) target[method] = () => run();
  return target as unknown as Connection;
}

afterEach(() => {
  resetRpcCache();
  resetRpcCircuit();
  resetRpcRateLimiters();
  setRpcLogger(null);
  setRpcRetryConfig(null);
});

describe("legacy configuration resolves to the 0.1.3 provider pair", () => {
  const envs = [
    {},
    { SOLANA_RPC_URL: "https://dedicated.example/?api-key=k" },
    { SOLANA_RPC_URL: PUBLIC_SOLANA_RPC_URL },
  ];
  for (const env of envs) {
    it(`same endpoints, order, and ids for ${Object.keys(env).join("+") || "no env"}`, () => {
      const pair = resolveProviderPair(env);
      const pool = resolveRpcPool(env);
      expect(pool.source).toBe("legacy");
      expect(pool.sticky).toBe(false);
      expect(pool.read).toBe(pool.transaction);
      const expected = [pair.primary, ...(pair.fallback ? [pair.fallback] : [])];
      expect(pool.transaction.map((m) => [m.endpoint, m.metricId])).toEqual(expected.map((p) => [p.endpoint, p.metricId]));
      expect(pool.transaction[0]).toMatchObject({ key: pair.primary.metricId, maxConcurrency: PRIMARY_RPC_CONCURRENCY, rps: null, trackHealth: true });
      if (pair.fallback) expect(pool.transaction[1]).toMatchObject({ maxConcurrency: null, rps: null, trackHealth: false });
      expect(pool.transaction.every((m) => m.name === undefined)).toBe(true);
    });
  }
});

describe("pool ≡ engine 0.1.3 for every method class, circuit state, and provider outcome", () => {
  const legacyEnvs: Array<{ label: string; env: Record<string, string>; primaryId: RpcMetricId }> = [
    { label: "SOLANA_RPC_URL only (current production)", env: { SOLANA_RPC_URL: "https://dedicated.example/?api-key=k" }, primaryId: "default" },
  ];
  for (const { label, env, primaryId } of legacyEnvs) {
    it(`rpcConnection / rpcReadConnection pool vs 0.1.3 createResilientConnection — ${label}`, async () => {
      const pair = resolveProviderPair(env);
      let compared = 0;
      for (const readOnly of [false, true])
      for (const { method, args } of METHODS) {
        for (const pre of PRE_STATES) {
          for (const primaryScript of PRIMARY_SCRIPTS) {
            for (const fallbackScript of FALLBACK_SCRIPTS) {
              if (fallbackScript === null) continue; // the env always has a fallback here
              const run = async (useLegacy: boolean) => {
                const events = prepare(primaryId, pre);
                const primary = scripted("primary", primaryScript);
                const fallback = scripted("fallback", fallbackScript);
                const primaryConn = fakeConnection(pair.primary.endpoint, primary.run);
                const fallbackConn = fakeConnection(pair.fallback!.endpoint, fallback.run);
                const connection = useLegacy
                  ? legacyResilientConnection(primaryConn, fallbackConn, { primaryId: pair.primary.metricId, fallbackId: pair.fallback!.metricId })
                  : createPooledConnection(resolveRpcPool(env), (member) => (member.endpoint === pair.primary.endpoint ? primaryConn : fallbackConn), { readOnly });
                const fn = (connection as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!;
                return observe(events, () => fn(...args), [primary.calls, fallback.calls], () => (useLegacy ? legacyLastMetric : lastRpcCallMetric)(connection));
              };
              const before = await run(true);
              const after = await run(false);
              expect(after, `${method} readOnly=${readOnly} pre=${pre} primary=${primaryScript} fallback=${fallbackScript}`).toEqual(before);
              compared += 1;
            }
          }
        }
      }
      expect(compared).toBe(2 * METHODS.length * PRE_STATES.length * PRIMARY_SCRIPTS.length * (FALLBACK_SCRIPTS.length - 1));
    }, 120_000);
  }

  it("invokeWithPolicy (history / raw JSON-RPC entry point) matches 0.1.3, with and without a fallback", async () => {
    for (const { method, args } of METHODS) {
      for (const pre of PRE_STATES) {
        for (const primaryScript of PRIMARY_SCRIPTS) {
          for (const fallbackScript of FALLBACK_SCRIPTS) {
            for (const ids of [["default", "default"]] as Array<[RpcMetricId, RpcMetricId]>) {
              const run = async (useLegacy: boolean) => {
                const events = prepare(ids[0], pre);
                const primary = scripted("primary", primaryScript);
                const fallback = scripted("fallback", fallbackScript ?? ["ok"]);
                const sink = {};
                const input = {
                  method, args, primary: primary.run, fallback: fallbackScript ? fallback.run : undefined,
                  primaryId: ids[0], fallbackId: ids[1],
                };
                return observe(
                  events,
                  async () => {
                    const result = useLegacy ? await legacyInvoke(input, sink) : await invokeWithPolicy(input, sink);
                    return { ...result };
                  },
                  [primary.calls, fallback.calls],
                  () => (useLegacy ? legacyLastMetric : lastRpcCallMetric)(sink),
                );
              };
              const before = await run(true);
              const after = await run(false);
              expect(after, `${method} ids=${ids} pre=${pre} primary=${primaryScript} fallback=${fallbackScript}`).toEqual(before);
            }
          }
        }
      }
    }
  }, 120_000);
});
