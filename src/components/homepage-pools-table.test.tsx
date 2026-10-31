// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadWithAprs } from "@/lib/range-apr/payload.fixture";
import { RWA_PAIRS_LIST_PATH } from "@/lib/rwa-pairs-list";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { toHomepagePoolsSnapshot, type HomepageSolanaRow } from "@/lib/homepage-pools";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";
import { HomepagePoolsTable, HomepagePoolsView } from "./homepage-pools-table";
import type { PoolRangeAprState } from "./range-apr/use-pool-range-apr";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));
const mocks = vi.hoisted(() => ({
  aprFor: vi.fn<(poolId: string, protocol?: string) => PoolRangeAprState>(() => ({ status: "loading" })),
  tokens: {} as Record<string, { icon: string | null }>,
}));
// The table reads APRs through `usePoolsApr7d` (the /app/rwa-pairs hook), which loads each pool through the shared
// client; `aprFor` states map to that client's promise (ready → payload, error → rejection, loading → pending).
vi.mock("./range-apr/pool-range-apr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./range-apr/pool-range-apr-client")>()),
  loadPoolRangeApr: (poolId: string, protocol?: string) => {
    const state = mocks.aprFor(poolId, protocol);
    if (state.status === "ready") return Promise.resolve(state.data);
    if (state.status === "error") return Promise.reject(new Error(state.message));
    return new Promise(() => {});
  },
}));

// Distinct pools need distinct mints: the /app/rwa-pairs duplicate rule keeps one pool per chain and token pair.
const mintsFor = (poolAddress: unknown) =>
  !poolAddress || poolAddress === "spcx-pool" ? { mintA: "mint-wrapped", mintB: "mint-plain" } : { mintA: `${poolAddress}-a`, mintB: `${poolAddress}-b` };
const pair = (overrides: Record<string, unknown>) => ({
  poolAddress: "pool",
  protocol: "raydium-clmm",
  nameA: "SpaceX xStock",
  nameB: "SpaceX",
  ...mintsFor(overrides.poolAddress),
  symbolA: "SPCXx",
  symbolB: "SPCX",
  wrappedSymbol: "SPCXx",
  plainSymbol: "SPCX",
  feeTierBps: 1,
  tvlUsd: 256_900,
  volume24hUsd: 888_000,
  estimatedFeeAprPct: 12.6,
  freezeRisk: true,
  token2022A: true,
  token2022B: true,
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  search = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mocks.tokens = {};
  mocks.aprFor.mockReset();
  mocks.aprFor.mockImplementation(() => ({ status: "loading" }));
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(highlightPool?: string) {
  if (highlightPool) search = `pool=${highlightPool}`;
  await act(async () => {
    root.render(createElement(HomepagePoolsTable));
  });
  // Lists, then the per-pool APR requests (queued on a timer), then their results: a few short rounds so a loaded
  // machine (the env matrix runs suites in parallel) still settles.
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

const RHC_URL = "/api/protocol-pools?protocol=uniswap-v4-rhc";

function jsonOk(body: unknown, rhcBody: unknown = { pools: [] }) {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url.startsWith("/api/token-metadata") ? { tokens: mocks.tokens } : url === RHC_URL ? rhcBody : body),
  }));
}

const rhcSummary = (index: number, tvlUsd: number): RhcPoolSummary => {
  const spec = UNIV4_RHC_ALLOWLISTED_POOLS[index]!;
  return {
    poolId: spec.poolId, status: "listed", tick: 0, price: null, warnings: [],
    estimatedApr: { tvlUsd, volume24hUsd: 500, estimatedPoolFeeAprPct: 3 },
    token0: { name: spec.currency0.symbol, symbol: spec.currency0.symbol },
    token1: { name: spec.currency1.symbol, symbol: spec.currency1.symbol },
  } as unknown as RhcPoolSummary;
};

const rowsOf = () => [...container.querySelectorAll('[data-testid="homepage-pools-table"] tbody tr')];
const keysOf = () => rowsOf().map((row) => row.getAttribute("data-pool"));
const aprOf = (row: Element) => row.querySelector("[data-testid='apr7d']")!;
const sol = (address: string) => `solana:${address}`;
const rhcKey = (index: number) => `robinhood:${UNIV4_RHC_ALLOWLISTED_POOLS[index]!.poolId.toLowerCase()}`;
const ready = (aprs: Parameters<typeof payloadWithAprs>[0]): PoolRangeAprState => ({ status: "ready", data: payloadWithAprs(aprs) });

describe("HomepagePoolsTable", () => {
  it("renders the /app/rwa-pairs list view (same PoolTable), loads the shared /api/rwa-pairs cache and deep-links Open", async () => {
    mocks.aprFor.mockImplementation((poolId) => (poolId === "spcx-pool" ? ready({ micro: 10, tight: 81, standard: 20, wide: 5 }) : { status: "loading" }));
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })], freshness: { snapshotAt: new Date().toISOString(), stale: false } });
    await mount();

    expect(fetchMock).toHaveBeenCalledWith(RWA_PAIRS_LIST_PATH, expect.objectContaining({ headers: { Accept: "application/json" } }));
    const table = container.querySelector('[data-testid="homepage-pools-table"] table')!;
    expect(table.getAttribute("data-testid")).toBe("homepage-pools-list");
    const [row] = rowsOf();
    expect(row!.getAttribute("data-pool")).toBe(sol("spcx-pool"));
    expect(row!.textContent).toContain("SPCXx/SPCX");
    expect(row!.textContent).toContain("$256.9k");
    expect(aprOf(row!).textContent).toBe("81.00%");
    expect(row!.querySelector("[data-testid='chain-badge']")!.textContent).toBe("Solana");
    // Same columns as the /app/rwa-pairs list view, as fixed labels (no sort buttons on the homepage).
    const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(headers.slice(0, 8)).toEqual(["Pool", "Chain", "Protocol", "Est. APR 7d", "Est. fee APR 24h", "TVL", "24h vol", "Risk"]);
    expect(table.querySelector("thead [aria-sort='descending']")!.textContent).toBe("Est. APR 7d");
    expect(table.querySelectorAll("thead button:not([aria-label^='About'])")).toHaveLength(0);
    expect(row!.querySelector("a[aria-label='Open position in SPCXx/SPCX']")!.getAttribute("href")).toBe("/app/rwa-pairs?pool=spcx-pool&open=1");
    const viewAll = container.querySelector("[data-testid='homepage-view-all']")!;
    expect(viewAll.getAttribute("href")).toBe("/app/rwa-pairs");
    expect(viewAll.textContent).toBe("View all pools →");
    expect(container.querySelector("a[href='/docs/fee-apr']")!.textContent).toBe("APR details");
    expect(container.textContent).not.toMatch(/\byield\b|\bearn\b|make your money|strateg|recipe|open[- ]source|\bMIT\b/i);
  });

  it("merges both chains, sorts by 7-day APR (high to low) and shows at most 5 pools", async () => {
    const solanaApr: Record<string, number> = { "a-pool": 103.5, "b-pool": 31.85, "c-pool": 15.27, "d-pool": 0.004, "e-pool": 4.72 };
    mocks.aprFor.mockImplementation((poolId, protocol) => {
      if (protocol === "uniswap-v4-rhc") return poolId === UNIV4_RHC_ALLOWLISTED_POOLS[1]!.poolId ? ready({ micro: 20 }) : ready({ micro: 0.5 });
      return solanaApr[poolId] !== undefined ? ready({ micro: solanaApr[poolId]! }) : { status: "error", message: "down" };
    });
    jsonOk(
      { pairs: ["a", "b", "c", "d", "e", "f"].map((id, i) => pair({ poolAddress: `${id}-pool`, symbolA: `${id.toUpperCase()}x`, symbolB: id.toUpperCase(), tvlUsd: 900_000 - i * 1000 })) },
      { pools: [rhcSummary(0, 1_000_000), rhcSummary(1, 10_000)] },
    );
    await mount();
    expect(keysOf()).toEqual([sol("a-pool"), sol("b-pool"), rhcKey(1), sol("c-pool"), sol("e-pool")]);
    expect(rowsOf().map((row) => row.getAttribute("data-chain"))).toEqual(["solana", "solana", "robinhood", "solana", "solana"]);
    expect(rowsOf().map((row) => aprOf(row).textContent)).toEqual(["103.50%", "31.85%", "20.00%", "15.27%", "4.72%"]);
    expect(rowsOf()[2]!.querySelector("[data-testid='chain-badge']")!.textContent).toBe("Robinhood Chain");
  });

  it("leaves out pools under $5k TVL before the duplicate rule, says so, and shows the actual count when fewer than 5 qualify", async () => {
    const apr: Record<string, number> = { "meta-tiny": 673.66, "meta-big": 40, "tsla-pool": 20, "small-pool": 300 };
    mocks.aprFor.mockImplementation((poolId) => (apr[poolId] !== undefined ? ready({ micro: apr[poolId]! }) : { status: "error", message: "down" }));
    jsonOk({ pairs: [
      pair({ poolAddress: "meta-tiny", symbolA: "METAx", symbolB: "META", mintA: "meta-x", mintB: "meta", tvlUsd: 1_023.91 }),
      pair({ poolAddress: "meta-big", symbolA: "METAx", symbolB: "META", mintA: "meta-x", mintB: "meta", tvlUsd: 48_000 }),
      pair({ poolAddress: "tsla-pool", symbolA: "TSLAx", symbolB: "TSLA", tvlUsd: 5_000 }),
      pair({ poolAddress: "small-pool", symbolA: "AMDx", symbolB: "AMD", tvlUsd: 4_999 }),
    ] });
    await mount();
    expect(keysOf()).toEqual([sol("meta-big"), sol("tsla-pool")]);
    // The APRs of pools under the floor are never requested.
    expect(mocks.aprFor.mock.calls.map(([poolId]) => poolId).sort()).toEqual(["meta-big", "tsla-pool"]);
    expect(container.querySelector("[data-testid=homepage-tvl-note]")!.textContent)
      .toBe("Pools under $5k TVL are not shown. 2 pools qualify right now.");
  });

  it("states the TVL floor without a count when 5 pools qualify", async () => {
    jsonOk({ pairs: ["a", "b", "c", "d", "e", "f"].map((id) => pair({ poolAddress: `${id}-pool`, symbolA: `${id.toUpperCase()}x`, symbolB: id.toUpperCase(), tvlUsd: 50_000 })) });
    await mount();
    expect(rowsOf()).toHaveLength(5);
    expect(container.querySelector("[data-testid=homepage-tvl-note]")!.textContent).toBe("Pools under $5k TVL are not shown.");
  });

  it("shows the paired token logos stored in the database (tokenIcons), wrapped token first, with the Raydium fallback", async () => {
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })],
      tokenIcons: { solana: { "mint-wrapped": "https://static.jup.ag/spcxx.png" }, robinhood: {} } });
    await mount();
    // No per-request Jupiter lookup any more: the icons ride along with /api/rwa-pairs.
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/token-metadata"))).toBe(false);
    const [row] = rowsOf();
    expect([...row!.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "https://static.jup.ag/spcxx.png",
      "https://img-v1.raydium.io/icon/mint-plain.png",
    ]);
  });

  it("puts the plain-stock logo second when the pool lists the wrapped token as B", async () => {
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool", mintA: "mint-plain", mintB: "mint-wrapped", symbolA: "SPCX", symbolB: "SPCXx" })],
      tokenIcons: { solana: { "mint-wrapped": "https://static.jup.ag/w.png", "mint-plain": "https://static.jup.ag/p.png" }, robinhood: {} } });
    await mount();
    expect([...rowsOf()[0]!.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "https://static.jup.ag/w.png",
      "https://static.jup.ag/p.png",
    ]);
  });

  it("shows … while the range APR loads and — when it is missing", async () => {
    mocks.aprFor.mockImplementation((poolId) => {
      if (poolId === "loading-pool") return { status: "loading" };
      if (poolId === "error-pool") return { status: "error", message: "down" };
      return ready({ micro: null, tight: null, standard: null, wide: null });
    });
    jsonOk({ pairs: [
      pair({ poolAddress: "loading-pool", tvlUsd: 300_000 }),
      pair({ poolAddress: "error-pool", tvlUsd: 200_000 }),
      pair({ poolAddress: "unpriced-pool", tvlUsd: 100_000 }),
    ] });
    await mount();
    expect(rowsOf().map((row) => aprOf(row).textContent)).toEqual(["…", "—", "—"]);
  });

  it("shows a loading status before pairs arrive", async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      root.render(createElement(HomepagePoolsTable));
    });
    expect(container.querySelector("[role='status']")!.textContent).toMatch(/Loading pool data/);
  });

  it("surfaces an error with a retry control", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "Snapshot unavailable" }) });
    await mount();
    expect(container.querySelector("[role='alert']")!.textContent).toContain("Snapshot unavailable");
    expect(container.querySelector("button")!.textContent).toBe("Try again");
  });

  it("handles an empty pair list", async () => {
    jsonOk({ pairs: [] });
    await mount();
    expect(container.textContent).toMatch(/No pools to show/);
    expect(container.querySelector("[data-testid='homepage-view-all']")!.getAttribute("href")).toBe("/app/rwa-pairs");
  });

  it("marks a highlighted pool from a tweet deep link, swapping it into the last slot", async () => {
    mocks.aprFor.mockImplementation((poolId) => (poolId === "hood-pool" ? { status: "error", message: "down" } : ready({ micro: 5 })));
    jsonOk({ pairs: [
      ...["a", "b", "c", "d", "e"].map((id) => pair({ poolAddress: `${id}-pool` })),
      pair({ poolAddress: "hood-pool", wrappedSymbol: "HOODx", plainSymbol: "HOOD", tvlUsd: 80_000 }),
    ] });
    await mount("hood-pool");
    expect(keysOf()).toHaveLength(5);
    expect(keysOf().at(-1)).toBe(sol("hood-pool"));
    const marked = container.querySelectorAll('[data-highlighted="true"]');
    expect([...marked].map((node) => node.getAttribute("data-pool"))).toEqual([sol("hood-pool")]);
  });

  it("renders the server snapshot at once, refreshes it from the API, and keeps it when the refresh fails", async () => {
    const initial = toHomepagePoolsSnapshot({
      solana: { pairs: [pair({ poolAddress: "spcx-pool" }) as HomepageSolanaRow], fetchedAt: "2026-10-30T11:02:00.000Z", stale: false },
      rhc: { pools: [rhcSummary(0, 50_000)], fetchedAt: "2026-10-30T11:02:56.939Z", stale: false },
    });
    fetchMock.mockImplementation(() => new Promise(() => {})); // refresh never answers yet
    await act(async () => {
      root.render(createElement(HomepagePoolsView, { initial }));
    });
    expect(container.textContent).not.toContain("Loading pool data");
    expect(container.textContent).toContain("SPCXx/SPCX");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(fetchMock).toHaveBeenCalledWith(RWA_PAIRS_LIST_PATH, expect.anything());
    expect(fetchMock).toHaveBeenCalledWith(RHC_URL, expect.anything());
    expect(container.querySelector("[data-testid='homepage-pools-updated']")!.textContent).toBe("Updated 2026-10-30 11:02 UTC");

    await act(async () => root.unmount());
    root = createRoot(container);
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("offline"));
    await act(async () => {
      root.render(createElement(HomepagePoolsView, { initial }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(container.textContent).toContain("SPCXx/SPCX");
    expect(container.textContent).toContain("SPCX/SPCXon");
    expect(container.textContent).not.toContain("offline");
    expect(container.textContent).toContain("Updated 2026-10-30 11:02 UTC");
  });

  it("lists Robinhood Chain pools next to Solana ones, with chain badges, protocol, Uniswap v4 APR and the RHC open link", async () => {
    mocks.aprFor.mockImplementation((_poolId, protocol) => (protocol === "uniswap-v4-rhc" ? ready({ micro: 5, tight: 33, standard: 9, wide: 2 }) : { status: "loading" }));
    jsonOk(
      { pairs: [pair({ poolAddress: "spcx-pool", tvlUsd: 256_900 })], fetchedAt: "2026-10-30T11:02:46.419Z", freshness: { snapshotAt: "2026-10-30T11:02:46.419Z", stale: false } },
      { pools: [rhcSummary(0, 52_000), rhcSummary(1, 300_000)], fetchedAt: "2026-10-29T11:05:00.000Z", snapshot: { stale: false } },
    );
    await mount();
    const rows = rowsOf();
    const nvda = UNIV4_RHC_ALLOWLISTED_POOLS[1]!;
    // Both RHC pools have a 7-day APR (33%), the Solana one is still loading: RHC first (tie → TVL), Solana last.
    expect(rows.map((row) => row.getAttribute("data-chain"))).toEqual(["robinhood", "robinhood", "solana"]);
    expect(rows[0]!.textContent).toContain("NVDA/NVDAon");
    // No stored icon for these tokens: the first-letter placeholder, never a blank circle.
    expect([...rows[0]!.querySelectorAll("[data-testid='token-icon-fallback']")].map((node) => node.textContent)).toEqual(["N", "N"]);
    expect(rows[0]!.querySelector("[data-testid='chain-badge']")!.textContent).toBe("Robinhood Chain");
    expect(rows[2]!.querySelector("[data-testid='chain-badge']")!.textContent).toBe("Solana");
    expect(rows[0]!.textContent).toContain("Uniswap v4");
    expect(rows[2]!.textContent).toContain("Raydium");
    expect(aprOf(rows[0]!).textContent).toBe("33.00%");
    expect(mocks.aprFor).toHaveBeenCalledWith(nvda.poolId, "uniswap-v4-rhc");
    expect(mocks.aprFor).toHaveBeenCalledWith("spcx-pool", "raydium-clmm");
    expect(rows[0]!.querySelector("a[href^='/app/rwa-pairs']")!.getAttribute("href")).toBe(`/app/rwa-pairs?openPool=${nvda.poolId}`);
    expect(rows[2]!.querySelector("a[href^='/app/rwa-pairs']")!.getAttribute("href")).toBe("/app/rwa-pairs?pool=spcx-pool&open=1");
    // Different minutes per chain: each chain gets its own time.
    expect(container.querySelector("[data-testid='homepage-pools-updated']")!.textContent).toBe(
      "Updated 2026-10-30 11:02 UTC (Solana) · 2026-10-29 11:05 UTC (Robinhood Chain)",
    );
  });

  it("keeps showing the Solana rows when only the Robinhood Chain request fails", async () => {
    fetchMock.mockImplementation(async (url: string) => url === RHC_URL
      ? { ok: false, json: async () => ({ error: "down" }) }
      : { ok: true, json: async () => ({ pairs: [pair({ poolAddress: "spcx-pool" })] }) });
    await mount();
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(rowsOf()).toHaveLength(1);
  });

  it("keeps the /app/rwa-pairs pick per pair: the highest 7-day APR pool, even with less TVL, and shows tiny APRs as <0.01%", async () => {
    mocks.aprFor.mockImplementation((poolId) =>
      poolId === "spcx-small" ? ready({ micro: 30, tight: 25, standard: 2, wide: 1 })
        : poolId === "spcx-pool" ? ready({ micro: 4, tight: 3, standard: 2, wide: 1 })
        : poolId === "tiny-pool" ? ready({ micro: 0.004, tight: 0.003, standard: 0.002, wide: 0.001 })
        : poolId === "zero-pool" ? ready({ micro: 0, tight: 0, standard: 0, wide: 0 })
        : { status: "error", message: "down" });
    jsonOk({ pairs: [
      pair({ poolAddress: "spcx-pool", tvlUsd: 256_900 }),
      pair({ poolAddress: "spcx-small", tvlUsd: 40_000, mintA: "mint-wrapped", mintB: "mint-plain" }),
      pair({ poolAddress: "tiny-pool", wrappedSymbol: "MSTRx", plainSymbol: "MSTR", symbolA: "MSTRx", symbolB: "MSTR", tvlUsd: 30_000 }),
      pair({ poolAddress: "zero-pool", wrappedSymbol: "GMEx", plainSymbol: "GME", symbolA: "GMEx", symbolB: "GME", tvlUsd: 25_000 }),
      pair({ poolAddress: "none-pool", wrappedSymbol: "TSLAx", plainSymbol: "TSLA", symbolA: "TSLAx", symbolB: "TSLA", tvlUsd: 20_000 }),
    ] });
    await mount();
    expect(keysOf()).toEqual([sol("spcx-small"), sol("tiny-pool"), sol("zero-pool"), sol("none-pool")]);
    const apr = rowsOf().map(aprOf);
    expect(apr.map((cell) => cell.textContent)).toEqual(["30.00%", "<0.01%", "0.00%", "—"]);
  });

  it("uses the server snapshot's 7-day APRs to pick and order pools until the client estimates load, without printing them", async () => {
    const pairs = [
      pair({ poolAddress: "spcx-pool", tvlUsd: 256_900 }) as HomepageSolanaRow,
      pair({ poolAddress: "spcx-small", tvlUsd: 40_000, mintA: "mint-wrapped", mintB: "mint-plain" }) as HomepageSolanaRow,
      pair({ poolAddress: "mstr-pool", symbolA: "MSTRx", symbolB: "MSTR", tvlUsd: 90_000 }) as HomepageSolanaRow,
    ];
    const initial = toHomepagePoolsSnapshot({
      solana: { pairs, fetchedAt: "2026-10-30T11:02:00.000Z", stale: false },
      apr7d: { "solana:spcx-small": 30, "solana:spcx-pool": 4, "solana:mstr-pool": 0.004 },
    });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      root.render(createElement(HomepagePoolsView, { initial }));
    });
    expect(keysOf()).toEqual([sol("spcx-small"), sol("mstr-pool")]);
    expect(rowsOf().map((row) => aprOf(row).textContent)).toEqual(["…", "…"]);
  });
});
