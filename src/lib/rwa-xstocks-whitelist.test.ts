import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { clearXstocksWhitelistCache, fetchXstocksSolanaMintSet } from "./rwa-xstocks-whitelist";

describe("fetchXstocksSolanaMintSet", () => {
  afterEach(() => {
    clearXstocksWhitelistCache();
    vi.restoreAllMocks();
  });

  it("paginates and collects Solana deployment addresses", async () => {
    let page = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("api.xstocks.fi/api/v2/public/assets");
      page += 1;
      if (page === 1) {
        return new Response(
          JSON.stringify({
            nodes: [
              {
                symbol: "AAONx",
                deployments: [
                  { network: "Ethereum", address: "0xabc" },
                  { network: "Solana", address: "SolMintAAON11111111111111111111111111111" },
                ],
              },
            ],
            page: { currentPage: 1, hasNextPage: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          nodes: [
            {
              symbol: "NVDAx",
              deployments: [{ network: "Solana", address: "SolMintNVDA11111111111111111111111111111" }],
            },
          ],
          page: { currentPage: 2, hasNextPage: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const mints = await fetchXstocksSolanaMintSet({
      fetcher: fetcher as unknown as typeof fetch,
      bypassCache: true,
    });
    expect(mints.has("SolMintAAON11111111111111111111111111111")).toBe(true);
    expect(mints.has("SolMintNVDA11111111111111111111111111111")).toBe(true);
    expect(mints.has("0xabc")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
