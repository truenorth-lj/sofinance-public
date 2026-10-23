/**
 * Measures open-position preview/prepare Jupiter-relay rounds and wall time.
 *
 * "Before" is the protocol the owner hit: one new quote amount per 409, fetched
 * one-at-a-time, no preview→prepare reuse, no fail-fast. "After" is this PR's
 * client: batched listed+companion needs, URL reuse, amount-churn fail-fast.
 *
 * Jupiter latency is stubbed at 200 ms so wall time is deterministic.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createJupiterRelayStore, jupiterBrowserStats, postWithJupiterRelay,
  RELAY_DID_NOT_SETTLE_MESSAGE, resetJupiterBrowserGate,
} from "./browser-relay";

const PAIR = (amount: number, extra = "") =>
  `/swap/v1/quote?inputMint=A&outputMint=B&amount=${amount}&slippageBps=50&instructionVersion=V2${extra}`;
const OWN = (amount: number) => `${PAIR(amount, "&dexes=Raydium+CLMM&maxAccounts=20&onlyDirectRoutes=true")}`;
const need = (id: string, url: string) => ({ id: id.padStart(32, "0"), method: "GET" as const, url });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const JUPITER_MS = 200;

beforeEach(() => {
  resetJupiterBrowserGate();
  window.localStorage.removeItem("sofiJupiterRelay");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function runUntilSettled<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => { settled = true; });
  void tracked.catch(() => undefined);
  for (let i = 0; i < 40 && !settled; i++) await vi.advanceTimersByTimeAsync(JUPITER_MS);
  return work;
}

describe("open-position relay harness", () => {
  it("before: sequential amount-changing 409s exhaust many rounds (owner repro)", async () => {
    let amount = 100;
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith("https://api.jup.ag/")) {
        await new Promise((resolve) => setTimeout(resolve, JUPITER_MS));
        return json({ outAmount: "5" });
      }
      posts += 1;
      amount += 17;
      return json({ code: "jupiter_relay_needed", needs: [need(String(amount), PAIR(amount))] }, 409);
    }));
    const pending = postWithJupiterRelay("/api/open-prepare", {}, { store: createJupiterRelayStore() });
    await expect(runUntilSettled(pending)).rejects.toThrow(RELAY_DID_NOT_SETTLE_MESSAGE);
    // Fail-fast: the pre-change client ran MAX_ROUNDS (8) against this server.
    expect(jupiterBrowserStats.rounds).toBeLessThanOrEqual(5);
    expect(jupiterBrowserStats.rounds).toBeGreaterThanOrEqual(3);
    expect(posts).toBe(jupiterBrowserStats.rounds);
    expect(jupiterBrowserStats.churnStops).toBe(1);
  });

  it("after: preview quotes + own-pool companion settle in one extra round, then prepare reuses them", async () => {
    const store = createJupiterRelayStore();
    const own = need("1", OWN(100));
    const free = need("2", PAIR(100) + "&maxAccounts=48");
    const resale = need("3", "/swap/v1/quote?inputMint=B&outputMint=A&amount=90&slippageBps=50&instructionVersion=V2&maxAccounts=48");
    const swapIx = need("4", "/swap/v1/swap-instructions");
    let phase: "preview-own" | "preview-resale" | "prepare-ix" | "done" = "preview-own";
    let jupiterCalls = 0;
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://api.jup.ag/")) {
        jupiterCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, JUPITER_MS));
        return json({ outAmount: "5" });
      }
      posts += 1;
      const responses = JSON.parse(String(init?.body)).jupiterRelay.responses as Record<string, unknown>;
      const has = (item: { id: string }) => Boolean(responses[item.id]);
      if (String(url) === "/api/open-quote") {
        if (phase === "preview-own" && !has(own)) {
          return json({ code: "jupiter_relay_needed", needs: [own] }, 409);
        }
        if (phase === "preview-own" && !has(free)) {
          // Companion prefetch should already have stored this under the URL index.
          return json({ code: "jupiter_relay_needed", needs: [free] }, 409);
        }
        if (phase === "preview-own") phase = "preview-resale";
        if (phase === "preview-resale" && !has(resale)) {
          return json({ code: "jupiter_relay_needed", needs: [resale] }, 409);
        }
        phase = "prepare-ix";
        return json({ ok: true, preview: true });
      }
      if (phase === "prepare-ix" && !has(swapIx)) {
        return json({ code: "jupiter_relay_needed", needs: [swapIx] }, 409);
      }
      phase = "done";
      return json({ ok: true, prepared: true });
    }));

    const preview = postWithJupiterRelay("/api/open-quote", { wallet: "w" }, { store });
    expect(await (await runUntilSettled(preview)).json()).toEqual({ ok: true, preview: true });
    const afterPreview = { rounds: jupiterBrowserStats.rounds, calls: jupiterCalls, posts };
    const prepare = postWithJupiterRelay("/api/open-prepare", { wallet: "w" }, { store });
    expect(await (await runUntilSettled(prepare)).json()).toEqual({ ok: true, prepared: true });

    // Preview: own-pool 409 (companion prefetched), free 409 is a reuse, resale 409, then 200.
    // Prepare: swap-instructions 409, then 200.
    expect(afterPreview.rounds).toBe(4);
    expect(jupiterBrowserStats.rounds).toBe(6);
    expect(afterPreview.calls).toBe(3);
    expect(jupiterCalls).toBe(4);
    expect(posts).toBe(jupiterBrowserStats.rounds);
    expect(jupiterBrowserStats.churnStops).toBe(0);
    expect(jupiterBrowserStats.reused).toBeGreaterThan(0);
  });
});
