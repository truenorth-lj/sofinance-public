import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toHomepagePoolsSnapshot, type HomepagePool } from "@/lib/homepage-pools";

// Server HTML must carry pool names (crawlers and AI fetchers do not run the client fetch).
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
const mocks = vi.hoisted(() => ({ getRwaPairs: vi.fn() }));
vi.mock("@/lib/rwa-store", () => ({ getRwaPairs: mocks.getRwaPairs }));

const pool = (wrapped: string, plain: string, tvlUsd: number, extra: Record<string, unknown> = {}): HomepagePool & Record<string, unknown> => ({
  poolAddress: `${plain.toLowerCase()}-pool`,
  mintA: `${wrapped}-mint`,
  mintB: `${plain}-mint`,
  symbolA: wrapped,
  symbolB: plain,
  wrappedSymbol: wrapped,
  plainSymbol: plain,
  feeTierBps: 1,
  tvlUsd,
  volume24hUsd: 100_000,
  estimatedFeeAprPct: 87.5,
  freezeRisk: true,
  token2022A: true,
  token2022B: false,
  nameA: "not needed by the homepage",
  jupiterTagsA: ["stocks"],
  ...extra,
});

const SNAPSHOT_AT = "2026-10-30T11:02:00.000Z";
const storeResult = {
  pairs: [pool("SPCXx", "SPCX", 250_000), pool("MSTRx", "MSTR", 120_000), pool("TSLAx", "TSLA", 90_000)],
  fetchedAt: SNAPSHOT_AT,
  freshness: { snapshotAt: SNAPSHOT_AT, stale: false },
  tokenIcons: { solana: { "SPCXx-mint": "https://example.test/spcxx.png", "unused-mint": "https://example.test/x.png" }, robinhood: {} },
};

beforeEach(() => {
  mocks.getRwaPairs.mockReset();
});

describe("homepage server render", () => {
  it("prerenders pool names and stats from the saved snapshot, not 'Loading pool data…', and no APR number", async () => {
    mocks.getRwaPairs.mockResolvedValue(storeResult);
    const { default: Home, revalidate } = await import("./page");
    expect(revalidate).toBe(900);
    const html = renderToString(await Home());

    expect(mocks.getRwaPairs).toHaveBeenCalledWith({ minTvl: 0, maxPages: 10, sortBy: "estimatedFeeApr" });
    expect(html).not.toContain("Loading pool data");
    for (const name of ["SPCXx/SPCX", "MSTRx/MSTR", "TSLAx/TSLA"]) expect(html).toContain(name);
    expect(html).toContain("$250.0k");
    expect(html).toContain("Snapshot 2026-10-30 11:02 UTC");
    // The range APR loads on the client; the cached HTML never states an APR figure.
    expect(html).not.toMatch(/\d+(\.\d+)?%\s*<\/span>|87\.5/);
    expect(html).toContain('"@type":"Organization"');
    expect(html).toContain('"@type":"WebSite"');
  });

  it("falls back to the client-loaded table when the snapshot read fails", async () => {
    mocks.getRwaPairs.mockRejectedValue(new Error("store down"));
    const { default: Home } = await import("./page");
    const html = renderToString(await Home());
    expect(html).toContain("Loading pool data");
  });
});

describe("toHomepagePoolsSnapshot", () => {
  it("keeps only the fields and icons the homepage table reads", () => {
    const snapshot = toHomepagePoolsSnapshot(storeResult);
    expect(snapshot.pairs.map((row) => row.plainSymbol)).toEqual(["SPCX", "MSTR", "TSLA"]);
    expect(Object.keys(snapshot.pairs[0]!)).not.toContain("nameA");
    expect(Object.keys(snapshot.pairs[0]!)).not.toContain("jupiterTagsA");
    expect(snapshot.tokenIcons).toEqual({ solana: { "SPCXx-mint": "https://example.test/spcxx.png" }, robinhood: {} });
    expect(snapshot.freshness).toEqual({ snapshotAt: SNAPSHOT_AT, stale: false });
  });
});
