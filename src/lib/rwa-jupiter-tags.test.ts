import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { clearJupiterTagsCache, fetchJupiterTagsByMint } from "./rwa-jupiter-tags";

describe("fetchJupiterTagsByMint", () => {
  afterEach(() => {
    clearJupiterTagsCache();
    vi.restoreAllMocks();
  });

  it("batches mint lookups and caches tags without logging the api key", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("/tokens/v2/search");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("secret-test-key");
      return new Response(
        JSON.stringify([
          { id: "Mint111111111111111111111111111111111111111", tags: ["stocks", "rwa", "xstocks"] },
          { id: "Mint222222222222222222222222222222222222222", tags: ["verified"] },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const tags = await fetchJupiterTagsByMint(
      ["Mint111111111111111111111111111111111111111", "Mint222222222222222222222222222222222222222"],
      { fetcher: fetcher as unknown as typeof fetch, apiKey: "secret-test-key", bypassCache: true },
    );

    expect(tags.get("Mint111111111111111111111111111111111111111")).toEqual([
      "stocks",
      "rwa",
      "xstocks",
    ]);
    expect(tags.get("Mint222222222222222222222222222222222222222")).toEqual(["verified"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
