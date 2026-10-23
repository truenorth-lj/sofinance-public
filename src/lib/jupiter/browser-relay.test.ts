// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companionQuoteNeeds, createJupiterRelayStore, expandRelayNeeds, jupiterBrowserStats,
  postWithJupiterRelay, RELAY_DID_NOT_SETTLE_MESSAGE, resetJupiterBrowserGate,
} from "./browser-relay";

const need = (id: string, url = `/swap/v1/quote?amount=${id}`) => ({ id: id.padStart(32, "0"), method: "GET" as const, url });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

beforeEach(() => {
  resetJupiterBrowserGate();
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
      const responses = body.jupiterRelay.responses;
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
      const responses = JSON.parse(String(init.body)).jupiterRelay.responses;
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
      const responses = JSON.parse(String(init.body)).jupiterRelay.responses;
      return responses[need("1").id] ? json({ status: responses[need("1").id].status }) : json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409);
    }));
    const pending = postWithJupiterRelay("/api/open-quote", {}, { store: createJupiterRelayStore() });
    await vi.advanceTimersByTimeAsync(2_300);
    expect(await (await pending).json()).toEqual({ status: 200 });
    expect(attempts).toBe(2);
    expect(jupiterBrowserStats.rateLimited).toBe(1);
  });

  it("passes Jupiter error statuses through to the server (no-route handling stays server-side)", async () => {
    let relayed: unknown;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) return json({ errorCode: "COULD_NOT_FIND_ANY_ROUTE" }, 400);
      const responses = JSON.parse(String(init.body)).jupiterRelay.responses;
      if (!responses[need("1").id]) return json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409);
      relayed = responses[need("1").id];
      return json({ error: "no route" }, 422);
    }));
    const response = await postWithJupiterRelay("/api/open-quote", {}, { store: createJupiterRelayStore() });
    expect(response.status).toBe(422);
    expect(relayed).toMatchObject({ status: 400, body: { errorCode: "COULD_NOT_FIND_ANY_ROUTE" } });
  });

  it("falls back to the server-keyed path when Jupiter is unreachable from the browser (CORS/network)", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.jup.ag/")) throw new TypeError("Failed to fetch");
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return body.jupiterRelay ? json({ code: "jupiter_relay_needed", needs: [need("1")] }, 409) : json({ ok: true });
    }));
    const response = await postWithJupiterRelay("/api/open-quote", { wallet: "w" }, { store: createJupiterRelayStore() });
    expect(await response.json()).toEqual({ ok: true });
    expect(bodies.at(-1)).toEqual({ wallet: "w" });
    expect(jupiterBrowserStats.fallbacks).toBe(1);
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
      const relay = JSON.parse(String(init.body)).jupiterRelay;
      sent.push(relay.hints);
      if (!relay.responses[need("1").id]) return json({ code: "jupiter_relay_needed", needs: [need("1")], hints: { k: "1" } }, 409);
      return json({ ok: true }, 200, { "x-jupiter-relay-hints": JSON.stringify({ k: "2" }) });
    }));
    await postWithJupiterRelay("/api/open-quote", {}, { store });
    await postWithJupiterRelay("/api/open-prepare", {}, { store });
    expect(sent).toEqual([{}, { k: "1" }, { k: "2" }]);
  });

  it("fails fast when the same pair keeps coming back at a new amount (prepare cannot settle)", async () => {
    let amount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("https://api.jup.ag/")) return json({ outAmount: "5" });
      amount += 1;
      return json({ code: "jupiter_relay_needed", needs: [need(String(amount), `/swap/v1/quote?inputMint=A&outputMint=B&amount=${amount}`)] }, 409);
    }));
    await expect(postWithJupiterRelay("/api/open-prepare", {}, { store: createJupiterRelayStore() }))
      .rejects.toThrow(RELAY_DID_NOT_SETTLE_MESSAGE);
    expect(jupiterBrowserStats.churnStops).toBe(1);
    expect(jupiterBrowserStats.rounds).toBeLessThan(8);
    expect(amount).toBeLessThan(8);
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
      const responses = JSON.parse(String(init?.body)).jupiterRelay.responses;
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
