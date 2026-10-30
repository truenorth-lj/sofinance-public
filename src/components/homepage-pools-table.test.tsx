// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIGHEST_RANGE_APR_7D_LABEL, HOMEPAGE_POOL_APR_LABEL } from "@/lib/apr-labels/copy";
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

describe("HomepagePoolsTable", () => {
  it("loads the shared /api/rwa-pairs cache, sorts by TVL, and deep-links Open position", async () => {
    mocks.aprFor.mockImplementation((poolId) =>
      poolId === "spcx-pool" ? { status: "ready", data: payloadWithAprs({ micro: 10, tight: 81, standard: 20, wide: 5 }) } : { status: "loading" });
    jsonOk({
      pairs: [
        pair({
          poolAddress: "sndk-pool",
          wrappedSymbol: "SNDKx",
          plainSymbol: "SNDK",
          tvlUsd: 953,
          estimatedFeeAprPct: 428.8,
        }),
        pair({ poolAddress: "spcx-pool" }),
      ],
      freshness: { snapshotAt: new Date().toISOString(), stale: false },
    });
    await mount();

    expect(fetchMock).toHaveBeenCalledWith(RWA_PAIRS_LIST_PATH, expect.objectContaining({
      headers: { Accept: "application/json" },
    }));
    const table = container.querySelector('[data-testid="homepage-pools-table"]')!;
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows[0]!.getAttribute("data-pool")).toBe("spcx-pool");
    expect(rows[0]!.textContent).toContain("SPCXx/SPCX");
    expect(rows[0]!.textContent).toContain("$256.9k");
    expect(rows[0]!.querySelector("[data-testid='homepage-apr']")!.textContent).toBe("81.00%");
    expect(rows[0]!.textContent).not.toContain("12.60%");
    expect(HOMEPAGE_POOL_APR_LABEL).toBe(HIGHEST_RANGE_APR_7D_LABEL);
    expect(table.querySelector("thead")!.textContent).toContain("Est. highest range APR · 7d avg · not guaranteed");
    expect(table.querySelector("thead button[aria-label='About Est. highest range APR']")).not.toBeNull();
    const docsLink = table.querySelector("thead a[href='/docs/fee-apr']")!;
    expect(docsLink.textContent).toBe("APR details");
    expect(rows[0]!.querySelector("a[href^='/app/rwa-pairs']")!.getAttribute("href")).toBe(
      "/app/rwa-pairs?pool=spcx-pool&open=1",
    );
    expect(rows.some((row) => row.getAttribute("data-pool") === "sndk-pool")).toBe(false);
    expect(container.textContent).toContain("See all pools");
    expect(container.textContent).not.toMatch(/\byield\b|\bearn\b|make your money|strateg|recipe|open[- ]source|\bMIT\b/i);
  });

  it("shows the paired token logos stored in the database (tokenIcons), wrapped token first, with the Raydium fallback", async () => {
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })],
      tokenIcons: { solana: { "mint-wrapped": "https://static.jup.ag/spcxx.png" }, robinhood: {} } });
    await mount();
    // No per-request Jupiter lookup any more: the icons ride along with /api/rwa-pairs.
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/token-metadata"))).toBe(false);
    const row = container.querySelector('[data-testid="homepage-pools-table"] tbody tr')!;
    expect([...row.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "https://static.jup.ag/spcxx.png",
      "https://img-v1.raydium.io/icon/mint-plain.png",
    ]);
    const card = container.querySelector('[data-testid="homepage-pools-cards"] li')!;
    expect(card.querySelectorAll("img")).toHaveLength(2);
  });

  it("shows Raydium icons when the response has no tokenIcons (store not migrated / older gateway)", async () => {
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })] });
    await mount();
    const row = container.querySelector('[data-testid="homepage-pools-table"] tbody tr')!;
    expect([...row.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "https://img-v1.raydium.io/icon/mint-wrapped.png",
      "https://img-v1.raydium.io/icon/mint-plain.png",
    ]);
  });

  it("puts the plain-stock logo second when the pool lists the wrapped token as B", async () => {
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool", mintA: "mint-plain", mintB: "mint-wrapped", symbolA: "SPCX", symbolB: "SPCXx" })],
      tokenIcons: { solana: { "mint-wrapped": "https://static.jup.ag/w.png", "mint-plain": "https://static.jup.ag/p.png" }, robinhood: {} } });
    await mount();
    const row = container.querySelector('[data-testid="homepage-pools-table"] tbody tr')!;
    expect([...row.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "https://static.jup.ag/w.png",
      "https://static.jup.ag/p.png",
    ]);
  });

  it("shows … while the range APR loads and — when it is missing, in both layouts", async () => {
    mocks.aprFor.mockImplementation((poolId) => {
      if (poolId === "loading-pool") return { status: "loading" };
      if (poolId === "error-pool") return { status: "error", message: "down" };
      return { status: "ready", data: payloadWithAprs({ micro: null, tight: null, standard: null, wide: null }) };
    });
    jsonOk({
      pairs: [
        pair({ poolAddress: "loading-pool", tvlUsd: 300_000 }),
        pair({ poolAddress: "error-pool", tvlUsd: 200_000 }),
        pair({ poolAddress: "unpriced-pool", tvlUsd: 100_000 }),
      ],
    });
    await mount();
    const values = (selector: string) =>
      [...container.querySelectorAll(`${selector} [data-testid='homepage-apr']`)].map((node) => node.textContent);
    expect(values('[data-testid="homepage-pools-table"]')).toEqual(["…", "—", "—"]);
    expect(values('[data-testid="homepage-pools-cards"]')).toEqual(["…", "—", "—"]);
  });

  it("keeps ranking by TVL regardless of APR", async () => {
    mocks.aprFor.mockImplementation((poolId) => ({
      status: "ready",
      data: payloadWithAprs(poolId === "small-pool" ? { standard: 300 } : { standard: 4 }),
    }));
    jsonOk({ pairs: [pair({ poolAddress: "small-pool", tvlUsd: 20_000 }), pair({ poolAddress: "big-pool", tvlUsd: 500_000 })] });
    await mount();
    const rows = [...container.querySelectorAll('[data-testid="homepage-pools-table"] tbody tr')];
    expect(rows.map((row) => row.getAttribute("data-pool"))).toEqual(["big-pool", "small-pool"]);
  });

  it("shows a loading status before pairs arrive", async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      root.render(createElement(HomepagePoolsTable));
    });
    expect(container.querySelector("[role='status']")!.textContent).toMatch(/Loading pool data/);
  });

  it("surfaces an error with a retry control", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Snapshot unavailable" }),
    });
    await mount();
    expect(container.querySelector("[role='alert']")!.textContent).toContain("Snapshot unavailable");
    expect(container.querySelector("button")!.textContent).toBe("Try again");
  });

  it("handles an empty pair list", async () => {
    jsonOk({ pairs: [] });
    await mount();
    expect(container.textContent).toMatch(/No same-asset pools/);
    expect(container.querySelector(`a[href='/app/rwa-pairs']`)).not.toBeNull();
  });

  it("marks a highlighted pool from a tweet deep link", async () => {
    jsonOk({
      pairs: [pair({ poolAddress: "spcx-pool" }), pair({ poolAddress: "hood-pool", wrappedSymbol: "HOODx", plainSymbol: "HOOD", tvlUsd: 80_000 })],
    });
    await mount("hood-pool");
    const marked = container.querySelectorAll('[data-highlighted="true"]');
    expect(marked.length).toBeGreaterThan(0);
    expect([...marked].every((node) => node.getAttribute("data-pool") === "hood-pool")).toBe(true);
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

  it("lists Robinhood Chain pools next to Solana ones, with chain tags, protocol, Uniswap v4 APR and the RHC open link", async () => {
    mocks.aprFor.mockImplementation((_poolId, protocol) =>
      protocol === "uniswap-v4-rhc" ? { status: "ready", data: payloadWithAprs({ micro: 5, tight: 33, standard: 9, wide: 2 }) } : { status: "loading" });
    jsonOk(
      { pairs: [pair({ poolAddress: "spcx-pool", tvlUsd: 256_900 })], fetchedAt: "2026-10-30T11:02:46.419Z", freshness: { snapshotAt: "2026-10-30T11:02:46.419Z", stale: false } },
      { pools: [rhcSummary(0, 52_000), rhcSummary(1, 300_000)], fetchedAt: "2026-10-29T11:05:00.000Z", snapshot: { stale: false } },
    );
    await mount();
    const rows = [...container.querySelectorAll('[data-testid="homepage-pools-table"] tbody tr')];
    const nvda = UNIV4_RHC_ALLOWLISTED_POOLS[1]!;
    expect(rows.map((row) => row.getAttribute("data-chain"))).toEqual(["robinhood", "solana", "robinhood"]);
    expect(rows[0]!.textContent).toContain(`${nvda.currency0.symbol}/${nvda.currency1.symbol}`);
    expect(rows[0]!.querySelector("[data-testid='homepage-chain']")!.textContent).toBe("Robinhood Chain");
    expect(rows[1]!.querySelector("[data-testid='homepage-chain']")!.textContent).toBe("Solana");
    expect(rows[0]!.textContent).toContain("Uniswap v4 · dynamic fee");
    expect(rows[1]!.textContent).toContain("Raydium · 1 bps");
    expect(rows[0]!.querySelector("[data-testid='homepage-apr']")!.textContent).toBe("33.00%");
    expect(mocks.aprFor).toHaveBeenCalledWith(nvda.poolId, "uniswap-v4-rhc");
    expect(mocks.aprFor).toHaveBeenCalledWith("spcx-pool", "raydium-clmm");
    expect(rows[0]!.querySelector("a[href^='/app/rwa-pairs']")!.getAttribute("href")).toBe(`/app/rwa-pairs?openPool=${nvda.poolId}`);
    expect(rows[1]!.querySelector("a[href^='/app/rwa-pairs']")!.getAttribute("href")).toBe("/app/rwa-pairs?pool=spcx-pool&open=1");
    // Different minutes per chain: each chain gets its own time.
    expect(container.querySelector("[data-testid='homepage-pools-updated']")!.textContent).toBe(
      "Updated 2026-10-30 11:02 UTC (Solana) · 2026-10-29 11:05 UTC (Robinhood Chain)",
    );
  });

  it("lists the USDC/USDT stablecoin pool after every same-stock pool, even with the highest TVL", async () => {
    jsonOk(
      { pairs: [
        pair({ poolAddress: "usdc-usdt", wrappedSymbol: "USDC", plainSymbol: "USDT", symbolA: "USDC", symbolB: "USDT", mintA: "usdc", mintB: "usdt", tvlUsd: 1_800_000, wrapKind: "stable" }),
        pair({ poolAddress: "spcx-pool", wrapKind: "suffix-x" }),
      ] },
      { pools: [rhcSummary(2, 45_000)] },
    );
    await mount();
    const rows = [...container.querySelectorAll('[data-testid="homepage-pools-table"] tbody tr')];
    expect(rows.map((row) => row.getAttribute("data-pool"))).toEqual(["spcx-pool", UNIV4_RHC_ALLOWLISTED_POOLS[2]!.poolId, "usdc-usdt"]);
    expect(rows[2]!.textContent).toContain("Stablecoins");
    expect(container.textContent).toContain("Stablecoin pools (USDC/USDT) are listed last");
  });

  it("keeps showing the Solana rows when only the Robinhood Chain request fails", async () => {
    fetchMock.mockImplementation(async (url: string) => url === RHC_URL
      ? { ok: false, json: async () => ({ error: "down" }) }
      : { ok: true, json: async () => ({ pairs: [pair({ poolAddress: "spcx-pool" })] }) });
    await mount();
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(container.querySelectorAll('[data-testid="homepage-pools-table"] tbody tr')).toHaveLength(1);
  });

  it("keeps the /app/rwa-pairs pick per pair: the highest 7-day APR pool, even with less TVL, and shows tiny APRs as <0.01%", async () => {
    mocks.aprFor.mockImplementation((poolId) =>
      poolId === "spcx-small" ? { status: "ready", data: payloadWithAprs({ micro: 30, tight: 25, standard: 2, wide: 1 }) }
        : poolId === "spcx-pool" ? { status: "ready", data: payloadWithAprs({ micro: 4, tight: 3, standard: 2, wide: 1 }) }
        : poolId === "tiny-pool" ? { status: "ready", data: payloadWithAprs({ micro: 0.004, tight: 0.003, standard: 0.002, wide: 0.001 }) }
        : { status: "error", message: "down" });
    jsonOk({ pairs: [
      pair({ poolAddress: "spcx-pool", tvlUsd: 256_900 }),
      pair({ poolAddress: "spcx-small", tvlUsd: 40_000, mintA: "mint-wrapped", mintB: "mint-plain" }),
      pair({ poolAddress: "tiny-pool", wrappedSymbol: "MSTRx", plainSymbol: "MSTR", symbolA: "MSTRx", symbolB: "MSTR", tvlUsd: 30_000 }),
      pair({ poolAddress: "none-pool", wrappedSymbol: "TSLAx", plainSymbol: "TSLA", symbolA: "TSLAx", symbolB: "TSLA", tvlUsd: 20_000 }),
    ] });
    await mount();
    const rows = [...container.querySelectorAll('[data-testid="homepage-pools-table"] tbody tr')];
    expect(rows.map((row) => row.getAttribute("data-pool"))).toEqual(["spcx-small", "tiny-pool", "none-pool"]);
    const apr = rows.map((row) => row.querySelector("[data-testid='homepage-apr']")!);
    expect(apr.map((cell) => cell.textContent)).toEqual(["30.00%", "<0.01%", "—"]);
    expect(apr[1]!.getAttribute("title")).toBe("≈0.0040%");
  });

  it("uses the server snapshot's 7-day APRs to pick pools until the client estimates load, without printing them", async () => {
    const pairs = [
      pair({ poolAddress: "spcx-pool", tvlUsd: 256_900 }) as HomepageSolanaRow,
      pair({ poolAddress: "spcx-small", tvlUsd: 40_000, mintA: "mint-wrapped", mintB: "mint-plain" }) as HomepageSolanaRow,
    ];
    const initial = toHomepagePoolsSnapshot({
      solana: { pairs, fetchedAt: "2026-10-30T11:02:00.000Z", stale: false },
      apr7d: { "solana:spcx-small": 30, "solana:spcx-pool": 4 },
    });
    expect(Object.keys(initial.apr7d)).toHaveLength(2);
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      root.render(createElement(HomepagePoolsView, { initial }));
    });
    const rows = [...container.querySelectorAll('[data-testid="homepage-pools-table"] tbody tr')];
    expect(rows.map((row) => row.getAttribute("data-pool"))).toEqual(["spcx-small"]);
    expect(rows[0]!.querySelector("[data-testid='homepage-apr']")!.textContent).toBe("…");
  });
});

