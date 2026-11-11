import { describe, expect, it, vi } from "vitest";
import { fetchJsonStatus } from "./http-json";

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fetchJsonStatus", () => {
  it("returns the status and parsed body of a 2xx, asking for JSON", async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { ok: 1 }));
    await expect(fetchJsonStatus("https://example.test/a", { fetcher, timeoutMs: 1_000 })).resolves.toEqual({ status: 200, body: { ok: 1 } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/a");
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a null body (unread) for non-2xx statuses", async () => {
    const response = jsonResponse(429, { error: "slow down" });
    const json = vi.spyOn(response, "json");
    await expect(fetchJsonStatus("https://example.test/a", { fetcher: async () => response, timeoutMs: 1_000 })).resolves.toEqual({ status: 429, body: null });
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects on invalid JSON in a 2xx and on network errors", async () => {
    await expect(fetchJsonStatus("u", { fetcher: async () => new Response("not json", { status: 200 }), timeoutMs: 1_000 })).rejects.toThrow();
    await expect(fetchJsonStatus("u", { fetcher: async () => { throw new TypeError("fetch failed"); }, timeoutMs: 1_000 })).rejects.toThrow("fetch failed");
  });

  it("passes a signal that aborts with the caller's signal", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { seen = init?.signal ?? undefined; return jsonResponse(200, {}); });
    await fetchJsonStatus("u", { fetcher: fetcher as typeof fetch, signal: controller.signal, timeoutMs: 60_000 });
    expect(seen?.aborted).toBe(false);
    controller.abort(new Error("cancelled"));
    expect(seen?.aborted).toBe(true);
  });

  it("passes a signal that aborts after the timeout", async () => {
    let seen: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { seen = init?.signal ?? undefined; return jsonResponse(200, {}); });
    await fetchJsonStatus("u", { fetcher: fetcher as typeof fetch, timeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen?.aborted).toBe(true);
  });
});
