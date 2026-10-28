// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureQuoteSettleFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry/capture", () => ({ captureQuoteSettleFailure }));

import {
  companionQuoteNeeds, conservativeQuoteAmount, createJupiterRelayStore, expandRelayNeeds,
  JUPITER_QUOTE_UNAVAILABLE_MESSAGE, jupiterBrowserStats, nextRelaySearchAmount, postWithJupiterRelay, quoteAmount,
  quoteAmountsWithinBps, quoteSettleFailureExtras, RELAY_DID_NOT_SETTLE_MESSAGE,
  resetJupiterBrowserGate,
} from "./browser-relay";

const need = (id: string, url = `/swap/v1/quote?amount=${id}`) => ({ id: id.padStart(32, "0"), method: "GET" as const, url });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const relayResponses = (init?: RequestInit): Record<string, { status: number } | undefined> =>
  (JSON.parse(String(init?.body)).jupiterRelay?.responses ?? {}) as Record<string, { status: number } | undefined>;

beforeEach(() => {
  resetJupiterBrowserGate();
  captureQuoteSettleFailure.mockReset();
  window.localStorage.removeItem("sofiJupiterRelay");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser Jupiter relay", () => {
  it("fetches the server's needs keylessly from api.jup.ag and replays them", async () => {
    const posts: unknown[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) {
        expect(init.credentials).toBe("omit");
        expect(new Headers(init.headers).has("x-api-key")).toBe(false);
        return json({ outAmount: "5" }, 200, { "x-ratelimit-remaining": "4" });
      }
      const body = JSON.parse(String(init.body));
      posts.push(body);
      const responses = relayResponses(init);
      if (!responses[need("1").id]) return json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409);
      return json({ ok: true, wallet: body.wallet });
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await postWithJupiterRelay("/api/open-quote", { wallet: "w" }, { store: createJupiterRelayStore() });
    expect(await response.json()).toEqual({ ok: true, wallet: "w" });
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith("https://api.jup.ag/swap/v1/quote?amount=1"))).toHaveLength(1);
    expect(posts).toHaveLength(2);
    expect(jupiterBrowserStats.quotes).toBe(1);
  });

  it("reuses a fresh response for the next request in the same flow (preview -> prepare)", async () => {
    const store = createJupiterRelayStore();
    let jupiterCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) { jupiterCalls++; return json({ outAmount: "5" }); }
      const responses = relayResponses(init);
      return responses[need("1").id] ? json({ ok: true }) : json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409);
    }));
    await postWithJupiterRelay("/api/selected-quote", {}, { store });
    await postWithJupiterRelay("/api/selected-prepare", {}, { store });
    expect(jupiterCalls).toBe(1);
  });

  it("waits out a 429 using Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) {
        attempts++;
        return attempts === 1 ? json({ error: "Rate limit" }, 429, { "retry-after": "2" }) : json({ outAmount: "5" });
      }
      const responses = relayResponses(init);
      return responses[need("1").id] ? json({ status: responses[need("1").id]!.status }) : json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409);
    }));
    const pending = postWithJupiterRelay("/api/open-quote", {}, { store: createJupiterRelayStore() });
    await vi.advanceTimersByTimeAsync(2_300);
    expect(await (await pending).json()).toEqual({ status: 200 });
    expect(attempts).toBe(2);
    expect(jupiterBrowserStats.rateLimited).toBe(1);
  });

  it("fails fast on a persistent Jupiter 429 instead of looping 409s", async () => {
    vi.useFakeTimers();
    let jupCalls = 0;
    let relayPosts = 0;
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) {
        jupCalls += 1;
        return json({ error: "Rate limit" }, 429, { "retry-after": "0" });
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (!body.jupiterRelay) {
        return bodies.length === 1
          ? json({ code: "jupiter_rate_limited", error: "limited" }, 503)
          : json({ ok: true, path: "server" });
      }
      relayPosts += 1;
      return json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409);
    }));
    const pending = postWithJupiterRelay("/api/open-quote", {}, { store: createJupiterRelayStore() });
    const settled = pending.then(async (response) => response.json());
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await settled).toEqual({ ok: true, path: "server" });
    expect(jupCalls).toBe(2);
    expect(relayPosts).toBe(1);
    expect(jupiterBrowserStats.rateLimited).toBe(2);
    expect(jupiterBrowserStats.servedBy).toBe("server_fallback");
  });

  it("passes Jupiter error statuses through to the server (no-route handling stays server-side)", async () => {
    let relayed: unknown;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) return json({ errorCode: "COULD_NOT_FIND_ANY_ROUTE" }, 400);
      const responses = relayResponses(init);
      if (!responses[need("1").id]) return json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409);
      relayed = responses[need("1").id];
      return json({ error: "no route" }, 422);
    }));
    const response = await postWithJupiterRelay("/api/open-quote", {}, { store: createJupiterRelayStore() });
    expect(response.status).toBe(422);
    expect(relayed).toMatchObject({ status: 400, body: { errorCode: "COULD_NOT_FIND_ANY_ROUTE" } });
  });

  it("uses the server-keyed path first when quota is healthy", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) throw new Error("browser must not be called");
      expect(JSON.parse(String(init.body)).jupiterRelay).toBeUndefined();
      return json({ ok: true, path: "server" });
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await postWithJupiterRelay("/api/open-quote", { wallet: "w" }, { store: createJupiterRelayStore() });
    expect(await response.json()).toEqual({ ok: true, path: "server" });
    expect(jupiterBrowserStats.servedBy).toBe("server");
    expect(jupiterBrowserStats.serverFirst).toBe(1);
    expect(jupiterBrowserStats.quotes).toBe(0);
  });

  it("falls back to the server-keyed path when the browser relay reports 429", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) return json({ error: "Rate limit" }, 429, { "retry-after": "1" });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (!body.jupiterRelay) {
        return bodies.length === 1
          ? json({ code: "jupiter_rate_limited", error: "Jupiter rate limit reached. Please retry later." }, 503)
          : json({ ok: true, path: "server" });
      }
      return json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409);
    }));
    vi.useFakeTimers();
    const pending = postWithJupiterRelay("/api/open-quote", { wallet: "w" }, { store: createJupiterRelayStore() });
    const settled = pending.then(async (response) => response.json());
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await settled).toEqual({ ok: true, path: "server" });
    expect(jupiterBrowserStats.fallbacks).toBe(1);
    expect(jupiterBrowserStats.servedBy).toBe("server_fallback");
    expect(jupiterBrowserStats.rateLimited).toBeGreaterThan(0);
    expect(bodies.at(-1)).toEqual({ wallet: "w" });
  });

  it("returns a clear error when both the server and the browser relay fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) return json({ error: "Rate limit" }, 429);
      const body = JSON.parse(String(init.body));
      if (!body.jupiterRelay) return json({ code: "jupiter_rate_limited", error: "limited" }, 503);
      return json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409);
    }));
    vi.useFakeTimers();
    const pending = postWithJupiterRelay("/api/open-quote", { wallet: "w" }, { store: createJupiterRelayStore() });
    const expected = expect(pending).rejects.toThrow(JUPITER_QUOTE_UNAVAILABLE_MESSAGE);
    await vi.advanceTimersByTimeAsync(3_500);
    await expected;
    expect(jupiterBrowserStats.fallbacks).toBe(1);
  });

  it("falls back to the server-keyed path when Jupiter is unreachable from the browser (CORS/network)", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) throw new TypeError("Failed to fetch");
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (!body.jupiterRelay) {
        return bodies.length === 1
          ? json({ code: "jupiter_rate_limited" }, 503)
          : json({ ok: true });
      }
      return json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409);
    }));
    const response = await postWithJupiterRelay("/api/open-quote", { wallet: "w" }, { store: createJupiterRelayStore() });
    expect(await response.json()).toEqual({ ok: true });
    expect(bodies.at(-1)).toEqual({ wallet: "w" });
    expect(jupiterBrowserStats.fallbacks).toBe(1);
    expect(jupiterBrowserStats.servedBy).toBe("server_fallback");
  });

  it("can be switched off per browser for debugging", async () => {
    window.localStorage.setItem("sofiJupiterRelay", "off");
    const fetcher = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await postWithJupiterRelay("/api/open-quote", { wallet: "w" }, { store: createJupiterRelayStore() });
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown[])[1] && ((fetcher.mock.calls[0] as unknown[])[1] as RequestInit).body))).toEqual({ wallet: "w" });
  });

  it("echoes the server's sizing hints on the next round and into prepare", async () => {
    const store = createJupiterRelayStore();
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) return json({ outAmount: "5" });
      const relay = JSON.parse(String(init.body)).jupiterRelay as { responses?: Record<string, unknown>; hints?: Record<string, string> } | undefined;
      sent.push(relay?.hints ?? {});
      if (!relay?.responses?.[need("1").id]) {
        return json({ code: "jupiter_relay_needed", needs: [need("1")], ...(relay ? { hints: { k: "1" } } : {}) }, 409);
      }
      return json({ ok: true }, 200, { "x-jupiter-relay-hints": JSON.stringify({ k: "2" }) });
    }));
    await postWithJupiterRelay("/api/open-quote", {}, { store });
    await postWithJupiterRelay("/api/open-prepare", {}, { store });
    expect(sent.at(-1)).toEqual({ k: "2" });
    expect(store.hints).toEqual({ k: "2" });
  });

  it("fails after a bounded binary search when the same pair keeps coming back at a new amount", async () => {
    let amount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("https://api.jup.ag/")) return json({ outAmount: "5" });
      amount += 1;
      return json({ code: "jupiter_relay_needed", needs: [need(String(amount), `/swap/v1/quote?inputMint=A&outputMint=B&amount=${amount}`)] }, 409);
    }));
    await expect(postWithJupiterRelay("/api/open-prepare", { amount: "5", rangePreset: "tight" }, { store: createJupiterRelayStore() }))
      .rejects.toThrow(RELAY_DID_NOT_SETTLE_MESSAGE);
    expect(jupiterBrowserStats.churnStops).toBe(1);
    expect(jupiterBrowserStats.binarySearches).toBeGreaterThan(0);
    expect(captureQuoteSettleFailure).toHaveBeenCalledTimes(1);
    expect(captureQuoteSettleFailure.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      amount: "5", rangeWidth: "tight", pair: "A/B", rounds: expect.any(Number),
    }));
    expect(JSON.stringify(captureQuoteSettleFailure.mock.calls[0]?.[1])).not.toMatch(/wallet/i);
  });

  it("treats consecutive quote amounts within 1% as settled and keeps the smaller amount", async () => {
    const store = createJupiterRelayStore();
    const sent: unknown[] = [];
    let step = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://api.jup.ag/")) return json({ outAmount: "5" });
      const relay = (JSON.parse(String(init?.body)).jupiterRelay ?? { hints: {}, responses: {} }) as { hints: Record<string, string>; responses: Record<string, unknown> };
      sent.push(relay.hints);
      if (step === 0) {
        step = 1;
        return json({ code: "jupiter_relay_needed", needs: [need("1000", "/swap/v1/quote?inputMint=A&outputMint=B&amount=1000")], hints: { k: "1000" } }, 409);
      }
      if (step === 1) {
        step = 2;
        return json({ code: "jupiter_relay_needed", needs: [need("1005", "/swap/v1/quote?inputMint=A&outputMint=B&amount=1005")], hints: { k: "1005" } }, 409);
      }
      return json({ ok: true, hints: relay.hints });
    }));
    expect(await (await postWithJupiterRelay("/api/open-quote", { amount: "2", rangePreset: "micro" }, { store })).json())
      .toEqual({ ok: true, hints: { k: "1000" } });
    expect(jupiterBrowserStats.churnStops).toBe(0);
    expect(captureQuoteSettleFailure).not.toHaveBeenCalled();
    expect(sent.at(-1)).toEqual({ k: "1000" });
  });

  it("binary-searches toward the midpoint after the churn limit, then settles", async () => {
    const store = createJupiterRelayStore();
    let amount = 100;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://api.jup.ag/")) return json({ outAmount: "5" });
      const hints = (JSON.parse(String(init?.body)).jupiterRelay?.hints ?? {}) as Record<string, string>;
      if (Object.values(hints).some((value) => value === "450")) return json({ ok: true });
      amount += 100;
      return json({
        code: "jupiter_relay_needed",
        needs: [need(String(amount), `/swap/v1/quote?inputMint=A&outputMint=B&amount=${amount}`)],
        hints: { k: String(amount) },
      }, 409);
    }));
    expect(await (await postWithJupiterRelay("/api/open-quote", { amount: "3", rangePreset: "standard" }, { store })).json())
      .toEqual({ ok: true });
    expect(jupiterBrowserStats.binarySearches).toBeGreaterThan(0);
    expect(jupiterBrowserStats.churnStops).toBe(0);
    expect(captureQuoteSettleFailure).not.toHaveBeenCalled();
  });

  it("does not treat resale (a new mint pair) as sizing churn", async () => {
    const store = createJupiterRelayStore();
    const sequence = [
      [need("1", "/swap/v1/quote?inputMint=A&outputMint=B&amount=10")],
      [need("2", "/swap/v1/quote?inputMint=B&outputMint=A&amount=9")],
    ];
    let step = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://api.jup.ag/")) return json({ outAmount: "5" });
      const responses = relayResponses(init);
      const pending = sequence[step];
      if (pending && !responses[pending[0]!.id]) return json({ code: "jupiter_relay_needed", needs: pending }, 409);
      step += 1;
      if (step < sequence.length) return json({ code: "jupiter_relay_needed", needs: sequence[step] }, 409);
      return json({ ok: true });
    }));
    expect(await (await postWithJupiterRelay("/api/open-quote", {}, { store })).json()).toEqual({ ok: true });
    expect(jupiterBrowserStats.churnStops).toBe(0);
  });
});

describe("quote amount convergence helpers", () => {
  it("detects a 1% gap and picks the conservative amount or midpoint", () => {
    expect(quoteAmount("/swap/v1/quote?inputMint=A&outputMint=B&amount=1000")).toBe(1000n);
    expect(quoteAmountsWithinBps(1000n, 1009n)).toBe(true);
    expect(quoteAmountsWithinBps(1000n, 1011n)).toBe(false);
    expect(conservativeQuoteAmount(1009n, 1000n)).toBe(1000n);
    expect(nextRelaySearchAmount(1000n, 1009n)).toBe(1000n);
    expect(nextRelaySearchAmount(200n, 400n)).toBe(300n);
    expect(quoteSettleFailureExtras({ amount: "5", rangePreset: "tight", wallet: "secret" }, [
      { url: "/swap/v1/quote?inputMint=MintA&outputMint=MintB&amount=1" },
    ], 4)).toEqual({ pair: "MintA/MintB", amount: "5", rangeWidth: "tight", rounds: 4 });
  });
});

describe("companion own-pool quotes", () => {
  it("prefetches the unconstrained quote next to a Raydium CLMM direct need", () => {
    const own = need("1", "/swap/v1/quote?inputMint=A&outputMint=B&amount=100&slippageBps=50&instructionVersion=V2&dexes=Raydium+CLMM&maxAccounts=20&onlyDirectRoutes=true");
    const extras = companionQuoteNeeds(own);
    expect(extras).toHaveLength(1);
    expect(extras[0]!.url).toContain("maxAccounts=48");
    expect(extras[0]!.url).not.toContain("onlyDirectRoutes");
    expect(extras[0]!.url).not.toContain("Raydium");
    expect(expandRelayNeeds([own]).map((item) => item.url)).toHaveLength(2);
  });
});
