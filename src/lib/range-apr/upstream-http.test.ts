import { describe, expect, it, vi } from "vitest";
import { fetchJsonOnce, parseRetryAfterMs } from "./upstream-http";

describe("parseRetryAfterMs", () => {
  it("reads delta seconds, HTTP dates and rejects junk", () => {
    expect(parseRetryAfterMs("30", 0)).toBe(30_000);
    expect(parseRetryAfterMs("1.5", 0)).toBe(1_500);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfterMs(new Date(1_000).toUTCString(), 4_000)).toBe(0);
    expect(parseRetryAfterMs("soon", 0)).toBeNull();
    expect(parseRetryAfterMs(null, 0)).toBeNull();
  });
});

describe("fetchJsonOnce", () => {
  it("returns the body and passes init (e.g. Next's revalidate) through", async () => {
    const fetcher = vi.fn(async () => new Response('{"a":1}', { status: 200 }));
    const result = await fetchJsonOnce(fetcher as unknown as typeof fetch, "https://x", 1000, { next: { revalidate: 60 } } as RequestInit);
    expect(result).toEqual({ ok: true, body: { a: 1 } });
    expect((fetcher.mock.calls[0] as unknown as [string, { next: unknown }])[1].next).toEqual({ revalidate: 60 });
  });

  it("keeps status and Retry-After of a failure", async () => {
    const fetcher = async () => new Response("{}", { status: 429, headers: { "Retry-After": "12" } });
    expect(await fetchJsonOnce(fetcher as unknown as typeof fetch, "https://x", 1000)).toEqual({
      ok: false, reason: "Upstream request failed (429)", status: 429, retryAfterMs: 12_000,
    });
  });

  it("turns network errors into a failure result", async () => {
    const fetcher = async () => { throw new Error("fetch failed"); };
    expect(await fetchJsonOnce(fetcher as unknown as typeof fetch, "https://x", 1000)).toEqual({ ok: false, reason: "fetch failed" });
  });
});
