import { afterEach, describe, expect, it, vi } from "vitest";
import { jupiterRelayActive, jupiterRelayHint, jupiterRequest, resetJupiterRateGate, setJupiterRelayHint } from "./client";
import { JupiterHttpError } from "./errors";
import { jupiterRelayId, parseJupiterRelay, parseJupiterRelayHints, runWithJupiterRelay } from "./relay";
import { resetJupiterCache, setJupiterCache } from "./cache";

const quoteRequest = { method: "GET" as const, url: "/swap/v1/quote?inputMint=A&outputMint=B&amount=10" };
const quote = (amount: string) => jupiterRequest<{ out: string }>({ path: "/swap/v1/quote", query: { inputMint: "A", outputMint: "B", amount }, fetcher: vi.fn(async () => { throw new Error("server must not call Jupiter in relay mode"); }) as never });

afterEach(() => {
  resetJupiterRateGate();
  resetJupiterCache();
  setJupiterCache(null);
});

describe("jupiter relay", () => {
  it("records a missing response as a need instead of calling Jupiter", async () => {
    const outcome = await runWithJupiterRelay(new Map(), () => quote("10"));
    expect(outcome.needs).toEqual([{ id: jupiterRelayId(quoteRequest), ...quoteRequest }]);
  });

  it("collects every parallel sibling's need in one round", async () => {
    const outcome = await runWithJupiterRelay(new Map(), () => Promise.all([quote("10"), quote("20")]));
    expect(outcome.needs?.map(need => need.url)).toEqual([quoteRequest.url, quoteRequest.url.replace("10", "20")]);
  });

  it("serves supplied responses without any server-side Jupiter call", async () => {
    const responses = new Map([[jupiterRelayId(quoteRequest), { status: 200, body: { out: "7" } }]]);
    const outcome = await runWithJupiterRelay(responses, async () => {
      expect(jupiterRelayActive()).toBe(true);
      return quote("10");
    });
    expect(outcome).toEqual({ needs: null, value: { out: "7" }, hints: {} });
    expect(jupiterRelayActive()).toBe(false);
  });

  it("maps a relayed Jupiter error status to JupiterHttpError with its body error", async () => {
    const responses = new Map([[jupiterRelayId(quoteRequest), { status: 400, body: { errorCode: "COULD_NOT_FIND_ANY_ROUTE" } }]]);
    const error = await runWithJupiterRelay(responses, () => quote("10")).catch(e => e);
    expect(error).toBeInstanceOf(JupiterHttpError);
    expect(error).toMatchObject({ status: 400, bodyError: "COULD_NOT_FIND_ANY_ROUTE" });
  });

  it("reports needs even when engine code swallowed the missing-response error", async () => {
    const outcome = await runWithJupiterRelay(new Map(), async () => {
      await quote("10").catch(() => null);
      return "degraded";
    });
    expect(outcome.needs).toHaveLength(1);
    expect(outcome.value).toBeUndefined();
  });

  it("ids are stable under body key order", () => {
    const a = jupiterRelayId({ method: "POST", url: "/swap/v1/swap-instructions", body: { a: 1, b: { c: 2, d: 3 } } });
    const b = jupiterRelayId({ method: "POST", url: "/swap/v1/swap-instructions", body: { b: { d: 3, c: 2 }, a: 1 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never caches relayed (client-supplied) responses for other callers", async () => {
    const cached = { path: "/swap/v1/quote", query: { inputMint: "A", outputMint: "B", amount: "10" }, cacheKey: "k", cacheTtlMs: 60_000 };
    const responses = new Map([[jupiterRelayId(quoteRequest), { status: 200, body: { out: "tampered" } }]]);
    await runWithJupiterRelay(responses, () => jupiterRequest(cached));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ out: "real" }), { status: 200 }));
    await expect(jupiterRequest({ ...cached, fetcher: fetcher as never })).resolves.toEqual({ out: "real" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("validates the untrusted relay payload", () => {
    expect(parseJupiterRelay(undefined)).toBeNull();
    expect(parseJupiterRelay({ responses: {} })?.size).toBe(0);
    expect(() => parseJupiterRelay({ responses: { nothex: { status: 200, body: {} } } })).toThrow(/Invalid/);
    expect(() => parseJupiterRelay({ responses: { ["a".repeat(32)]: { status: 99, body: {} } } })).toThrow(/status/);
    const many = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [i.toString(16).padStart(32, "0"), { status: 200, body: {} }]));
    expect(() => parseJupiterRelay({ responses: many })).toThrow(/Too many/);
  });

  it("carries sizing hints between rounds and only inside relay mode", async () => {
    setJupiterRelayHint("k", 5n);
    expect(jupiterRelayHint("k")).toBeUndefined();
    const outcome = await runWithJupiterRelay(new Map(), async () => {
      expect(jupiterRelayHint("k")).toBe(7n);
      setJupiterRelayHint("k", 9n);
      return quote("10");
    }, new Map([["k", "7"]]));
    expect(outcome.needs).toHaveLength(1);
    expect(outcome.hints).toEqual({ k: "9" });
  });

  it("validates untrusted hints", () => {
    expect(parseJupiterRelayHints(undefined).size).toBe(0);
    expect(parseJupiterRelayHints({ a: "12" }).get("a")).toBe("12");
    expect(() => parseJupiterRelayHints({ a: "-1" })).toThrow(/hint/);
    expect(() => parseJupiterRelayHints({ a: 12 })).toThrow(/hint/);
  });
});
