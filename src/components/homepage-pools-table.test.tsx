// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardPayloadWithAprs } from "@/lib/range-apr/payload.fixture";
import { RWA_PAIRS_LIST_PATH } from "@/lib/rwa-pairs-list";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { toHomepagePoolsSnapshot, type HomepageSolanaRow } from "@/lib/homepage-pools";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";
import { HomepageMarket, HomepageMarketView } from "./homepage-market";
import type { PoolRangeAprState } from "./range-apr/use-pool-range-apr";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));
const mocks = vi.hoisted(() => ({
  aprFor: vi.fn<(poolId: string, protocol?: string) => PoolRangeAprState>(() => ({ status: "loading" })),
  nativeOpenDisabled: false,
  tokens: {} as Record<string, { icon: string | null }>,
}));
vi.mock("@/lib/dex/client", async original => {
  const actual = await original<typeof import("@/lib/dex/client")>();
  return { ...actual, dexDescriptors: { ...actual.dexDescriptors, descriptorFor: (id: string) => {
    const descriptor = actual.dexDescriptors.descriptorFor(id);
    return mocks.nativeOpenDisabled && descriptor?.nativeCapabilities
      ? { ...descriptor, nativeCapabilities: { ...descriptor.nativeCapabilities, open: { supported: false as const, reason: "Native opening is unavailable" } } }
      : descriptor;
  } } };
});
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
  mocks.nativeOpenDisabled = false;
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
    root.render(createElement(HomepageMarket));
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


/** The homepage's single top-5 block. */
const rowsOf = () => [...container.querySelectorAll('[data-testid="top-pools"] tbody tr[data-pool]')];
const keysOf = () => rowsOf().map((row) => row.getAttribute("data-pool"));
const aprOf = (row: Element) => row.querySelector("[data-testid='top-pool-apr']")!;
const statusText = () => [...container.querySelectorAll("[role='status']")].map((node) => node.textContent).join(" | ");
/** Types into a search box the way React sees it (native setter + input event). */
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const sol = (address: string) => `solana:${address}`;
const rhcKey = (index: number) => `robinhood:${UNIV4_RHC_ALLOWLISTED_POOLS[index]!.poolId.toLowerCase()}`;
const ready = (aprs: Parameters<typeof cardPayloadWithAprs>[0]): PoolRangeAprState => ({ status: "ready", data: cardPayloadWithAprs(aprs) });

describe("homepage pools: single top-5 block", () => {
  it("renders the top-5 block, loads the shared /api/rwa-pairs cache and deep-links Open", async () => {
    mocks.aprFor.mockImplementation((poolId) => (poolId === "spcx-pool" ? ready({ micro: 10, tight: 81, standard: 20, wide: 5 }) : { status: "loading" }));
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })], freshness: { snapshotAt: new Date().toISOString(), stale: false } });
    await mount();

    expect(fetchMock).toHaveBeenCalledWith(RWA_PAIRS_LIST_PATH, expect.objectContaining({ headers: { Accept: "application/json" } }));
    expect(container.querySelector("#pools #top-pools-heading")!.textContent).toBe("Top pools");
    expect(container.textContent).toContain("Pools over $5k TVL, ranked by 7d estimated APR.");
    expect(container.textContent).not.toContain("All pools");
    expect(container.textContent).not.toMatch(/same-stock/i);
    const [row] = rowsOf();
    expect(row!.getAttribute("data-pool")).toBe(sol("spcx-pool"));
    expect(row!.textContent).toContain("SPCXx/SPCX");
    expect(row!.textContent).toContain("Raydium");
    expect(row!.querySelector("[data-testid='top-pool-tvl']")!.textContent).toBe("$256.9k");
    expect(aprOf(row!).textContent).toBe("81.00%");
    expect(row!.querySelector("[data-testid='chain-badge']")!.textContent).toBe("Solana");
    const headers = [...container.querySelectorAll('[data-testid="top-pools"] thead th')].map((th) => th.textContent);
    expect(headers).toEqual(["Pool", "Chain", "TVL", "APR"]);
    expect(headers).not.toContain("7d APR");
    expect(row!.querySelector("a[aria-label='Open position in SPCXx/SPCX']")!.getAttribute("href")).toBe("/app/rwa-pairs?openPool=spcx-pool");
    expect(row!.querySelectorAll("button")).toHaveLength(0);
    const viewAll = container.querySelector("[data-testid='homepage-view-all']")!;
    expect(viewAll.getAttribute("href")).toBe("/app/rwa-pairs");
    expect(viewAll.textContent).toBe("See all 1 pool →");
    expect(container.querySelector("a[href='/docs/fee-apr']")!.textContent).toBe("How estimates work");
    expect(container.querySelector("#pools a[href='/docs/risks']")!.textContent).toBe("Risks");
    expect(container.textContent).not.toMatch(/\byield\b|\bearn\b|make your money|strateg|recipe|open[- ]source|\bMIT\b/i);
  });

  it("opens a Meteora pool in its /app/rwa-pairs dialog (?openPool=), like the pools page does", async () => {
    mocks.aprFor.mockImplementation((poolId) => (poolId === "met-pool" ? ready({ micro: 10, tight: 30, standard: 20, wide: 5 }) : { status: "loading" }));
    jsonOk({ pairs: [pair({ poolAddress: "met-pool", protocol: "meteora-dlmm" })], freshness: { snapshotAt: new Date().toISOString(), stale: false } });
    await mount();
    const [row] = rowsOf();
    expect(row!.getAttribute("data-pool")).toBe(sol("met-pool"));
    expect(row!.textContent).toContain("Meteora");
    expect(row!.querySelector("[data-testid=open-disabled]")).toBeNull();
    expect(row!.textContent).not.toContain("isn't available yet");
    expect(row!.querySelector("a[aria-label='Open position in SPCXx/SPCX']")!.getAttribute("href")).toBe("/app/rwa-pairs?openPool=met-pool");
  });

  it("leaves out a pool whose token is not supported yet (NVDAx, ScaledUiAmount): not in the top 5, its APR never read", async () => {
    mocks.aprFor.mockImplementation((poolId) => (poolId === "nvda-pool" ? ready({ micro: 300, tight: 300, standard: 300, wide: 300 })
      : poolId === "spcx-pool" ? ready({ micro: 10, tight: 10, standard: 10, wide: 10 }) : { status: "loading" }));
    jsonOk({ pairs: [
      pair({ poolAddress: "nvda-pool", symbolA: "NVDAx", symbolB: "NVDA", wrappedSymbol: "NVDAx", plainSymbol: "NVDA", tvlUsd: 10_500,
        unsupported: { issues: ["ScaledUiAmount multiplier not 1"], mints: ["nvdax"] } }),
      pair({ poolAddress: "spcx-pool", tvlUsd: 20_000 }),
    ], freshness: { snapshotAt: new Date().toISOString(), stale: false } });
    await mount();
    expect(keysOf()).toEqual([sol("spcx-pool")]);
    expect(container.textContent).not.toContain("NVDAx/NVDA");
    expect(container.textContent).not.toContain("Not supported yet");
    expect(container.querySelector("[data-testid=open-unsupported]")).toBeNull();
    expect(mocks.aprFor.mock.calls.some(([poolId]) => poolId === "nvda-pool")).toBe(false);
    expect(container.querySelector("[data-testid=homepage-view-all]")!.textContent).toBe("See all 1 pool →");
  });

  it("merges both chains by 7-day APR (high to low): the top 5 is across both chains, See all N is the full list", async () => {
    const solanaApr: Record<string, number> = { "a-pool": 103.5, "b-pool": 31.85, "c-pool": 15.27, "d-pool": 0.004, "e-pool": 4.72 };
    mocks.aprFor.mockImplementation((poolId, protocol) => {
      if (protocol === "uniswap-v4-rhc") return poolId === UNIV4_RHC_ALLOWLISTED_POOLS[1]!.poolId ? ready({ micro: 20 }) : ready({ micro: 0.5 });
      return solanaApr[poolId] !== undefined ? ready({ micro: solanaApr[poolId]! }) : { status: "error", message: "down" };
    });
    jsonOk(
      { pairs: [
        pair({ poolAddress: "a-pool", tvlUsd: 20_000, symbolA: "Ax", symbolB: "A" }),
        pair({ poolAddress: "b-pool", tvlUsd: 20_000, symbolA: "Bx", symbolB: "B" }),
        pair({ poolAddress: "c-pool", tvlUsd: 20_000, symbolA: "Cx", symbolB: "C" }),
        pair({ poolAddress: "d-pool", tvlUsd: 20_000, symbolA: "Dx", symbolB: "D" }),
        pair({ poolAddress: "e-pool", tvlUsd: 20_000, symbolA: "Ex", symbolB: "E" }),
        pair({ poolAddress: "f-pool", tvlUsd: 20_000, symbolA: "Fx", symbolB: "F" }),
      ] },
      { pools: [rhcSummary(0, 52_000), rhcSummary(1, 80_000)] },
    );
    await mount();
    expect(keysOf()).toEqual([sol("a-pool"), sol("b-pool"), rhcKey(1), sol("c-pool"), sol("e-pool")]);
    expect(rowsOf().map((row) => aprOf(row).textContent)).toEqual(["103.50%", "31.85%", "20.00%", "15.27%", "4.72%"]);
    expect(rowsOf()[2]!.querySelector("[data-testid='chain-badge']")!.textContent).toBe("Robinhood Chain");
    // 6 Solana + 2 RHC, one Solana has no APR (f) but still counts in the full list, d has a tiny APR so it is listed too: 8.
    expect(container.querySelector("[data-testid=homepage-view-all]")!.textContent).toBe("See all 8 pools →");
  });

  it("leaves out pools under $5k TVL before the duplicate rule; See all N is the /app/rwa-pairs default view (no floor)", async () => {
    const apr: Record<string, number> = { "meta-tiny": 673.66, "meta-big": 40, "tsla-pool": 20, "small-pool": 300 };
    mocks.aprFor.mockImplementation((poolId) => (apr[poolId] !== undefined ? ready({ micro: apr[poolId]! }) : { status: "error", message: "down" }));
    jsonOk({ pairs: [
      pair({ poolAddress: "meta-tiny", symbolA: "METAx", symbolB: "META", mintA: "meta-x", mintB: "meta", tvlUsd: 1_023.91 }),
      pair({ poolAddress: "meta-big", symbolA: "METAx", symbolB: "META", mintA: "meta-x", mintB: "meta", tvlUsd: 48_000 }),
      pair({ poolAddress: "tsla-pool", symbolA: "TSLAx", symbolB: "TSLA", tvlUsd: 5_000 }),
      pair({ poolAddress: "small-pool", symbolA: "AMDx", symbolB: "AMD", tvlUsd: 4_999 }),
    ] });
    await mount();
    const block = container.querySelector("[data-testid=top-pools]")!;
    expect(block.textContent).toContain("Pools over $5k TVL, ranked by 7d estimated APR.");
    expect(keysOf()).toEqual([sol("meta-big"), sol("tsla-pool")]);
    const firstApr = aprOf(rowsOf()[0]!);
    expect(firstApr.textContent).toBe("40.00%");
    expect(firstApr.getAttribute("title")).toMatch(/^Best range: Micro\. Estimated from the past 7 days/);
    expect(rowsOf()[0]!.textContent).toContain(", Micro range");
    expect(mocks.aprFor.mock.calls.map(([poolId]) => poolId).sort()).toEqual(["meta-big", "meta-tiny", "small-pool", "tsla-pool"]);
    // Full list: tiny META wins the pair, plus tsla and small (Low TVL) = 3 (1 duplicate hidden).
    expect(container.querySelector("[data-testid=homepage-view-all]")!.textContent).toBe("See all 3 pools →");
  });

  it("shows the paired token logos stored in the database (tokenIcons), wrapped token first, with the Raydium fallback", async () => {
    mocks.aprFor.mockImplementation(() => ready({ micro: 5 }));
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })],
      tokenIcons: { solana: { "mint-wrapped": "https://static.jup.ag/spcxx.png" }, robinhood: {} } });
    await mount();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/token-metadata"))).toBe(false);
    const [row] = rowsOf();
    expect([...row!.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "https://static.jup.ag/spcxx.png",
      "https://img-v1.raydium.io/icon/mint-plain.png",
    ]);
  });

  it("puts the plain-stock logo second when the pool lists the wrapped token as B", async () => {
    mocks.aprFor.mockImplementation(() => ready({ micro: 5 }));
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool", mintA: "mint-plain", mintB: "mint-wrapped", symbolA: "SPCX", symbolB: "SPCXx" })],
      tokenIcons: { solana: { "mint-wrapped": "https://static.jup.ag/w.png", "mint-plain": "https://static.jup.ag/p.png" }, robinhood: {} } });
    await mount();
    expect([...rowsOf()[0]!.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "https://static.jup.ag/w.png",
      "https://static.jup.ag/p.png",
    ]);
  });

  it("prints the server snapshot's 7-day APR in the top 5 and leaves known misses out", async () => {
    const pairs = [
      pair({ poolAddress: "spcx-pool", tvlUsd: 300_000 }) as HomepageSolanaRow,
      pair({ poolAddress: "error-pool", tvlUsd: 200_000, symbolA: "Ex", symbolB: "E" }) as HomepageSolanaRow,
    ];
    const initial = toHomepagePoolsSnapshot({
      solana: { pairs, fetchedAt: "2026-10-30T11:02:00.000Z", stale: false },
      apr7d: { "solana:spcx-pool": 12.5 },
    });
    mocks.aprFor.mockImplementation((poolId) => {
      if (poolId === "spcx-pool") return { status: "loading" };
      return { status: "error", message: "down" };
    });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      root.render(createElement(HomepageMarketView, { initialPools: initial }));
    });
    expect(keysOf()).toEqual([sol("spcx-pool")]);
    expect(aprOf(rowsOf()[0]!).textContent).toBe("12.50%");
  });

  it("shows a loading status before pairs arrive", async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      root.render(createElement(HomepageMarket));
    });
    expect(statusText()).toMatch(/Loading pool data/);
    expect(statusText()).toMatch(/Loading stock data/);
    for (const card of ["stock-card-gainers", "stock-card-stocks"]) {
      const rows = container.querySelectorAll(`[data-testid=${card}] [data-testid=market-rows-skeleton] li[aria-hidden=true]`);
      expect(rows, card).toHaveLength(5);
      expect(rows[0]!.className, card).toContain("min-h-16");
    }
    expect(container.querySelector("[data-testid=top-pools-card]")).toBeNull();
    expect(container.querySelector("[data-testid=homepage-view-all]")).toBeNull();
  });

  it("surfaces an error with a retry control", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "Snapshot unavailable" }) });
    await mount();
    expect(container.querySelector("[role='alert']")!.textContent).toContain("Snapshot unavailable");
    expect(container.querySelector("[role='alert'] button")!.textContent).toBe("Try again");
    expect(container.querySelector("[data-testid=homepage-view-all]")).toBeNull();
  });

  it("handles an empty pair list", async () => {
    jsonOk({ pairs: [] });
    await mount();
    expect(container.textContent).toMatch(/No pools to show/);
    expect(container.querySelector("[data-testid='homepage-view-all']")!.getAttribute("href")).toBe("/app/rwa-pairs");
    expect(container.querySelector("[data-testid='homepage-view-all']")!.textContent).toBe("See all 0 pools →");
  });

  it("does not put a shared-link pool that is outside the top 5 into the block", async () => {
    mocks.aprFor.mockImplementation((poolId) => (poolId === "hood-pool" ? ready({ micro: 1 }) : ready({ micro: 5 })));
    jsonOk({ pairs: [
      ...["a", "b", "c", "d", "e"].map((id) => pair({ poolAddress: `${id}-pool` })),
      pair({ poolAddress: "hood-pool", wrappedSymbol: "HOODx", plainSymbol: "HOOD", tvlUsd: 80_000 }),
    ] });
    await mount("hood-pool");
    expect(keysOf()).toHaveLength(5);
    expect(keysOf()).not.toContain(sol("hood-pool"));
    expect(container.querySelectorAll("[data-highlighted]")).toHaveLength(0);
  });

  it("Enter in the hero search scrolls to the top-5 block (the list search is gone with the all-pools section)", async () => {
    mocks.aprFor.mockImplementation(() => ready({ micro: 5 }));
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })] });
    await mount();
    const scrolled = vi.fn();
    container.querySelector<HTMLElement>("#pools")!.scrollIntoView = scrolled;
    const hero = container.querySelector<HTMLInputElement>("#hero-search")!;
    hero.focus();
    await typeInto(hero, "spcx");
    await act(async () => { hero.form!.requestSubmit(); });
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(container.querySelector("#pools-search")).toBeNull();
    expect(document.activeElement).toBe(hero);
  });

  it("the line under the hero search grows out of the field only after typing, never on page load", async () => {
    mocks.aprFor.mockImplementation(() => ready({ micro: 5 }));
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })] });
    await mount();
    const line = () => container.querySelector("[data-testid=landing-hero] [aria-live=polite] > span")!;
    expect(line().textContent).toContain("0 keys on our servers");
    expect(line().className).not.toContain("animate-emerge");
    await typeInto(container.querySelector<HTMLInputElement>("#hero-search")!, "spcx");
    expect(line().textContent).toContain("1 pool matches");
    expect(line().className).toContain("motion-safe:animate-emerge");
  });

  it("nests the stock cards' corners from the outside in; the hero search is a pill", async () => {
    mocks.aprFor.mockImplementation(() => ready({ micro: 5 }));
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })] });
    await mount();
    for (const id of ["stock-card-gainers", "stock-card-stocks"]) {
      const card = container.querySelector<HTMLElement>(`[data-testid=${id}]`)!;
      expect(card.className, id).toMatch(/\brounded-surface\b.*\bp-4\b.*\[--radius-inset:0\.75rem\]/);
      expect(card.className, id).not.toMatch(/\bsm:p-/);
      const panel = card.querySelector("ol")!;
      expect(panel.className, id).toMatch(/\brounded-inset\b.*\bp-1\b/);
      expect(panel.querySelector(".min-h-16")!.className, id).toMatch(/\brounded-lg\b.*\bpy-2\b/);
    }
    expect(container.querySelector("#hero-search")!.parentElement!.className).toMatch(/\brounded-full\b/);
    expect(container.querySelector("#hero-search")!.className).toMatch(/(^|\s)text-base(\s|$)/);
    expect(container.querySelector("#pools-search")).toBeNull();
  });

  it("top-5 rows show the pair as one stacked 32 px icon", async () => {
    mocks.aprFor.mockImplementation(() => ready({ micro: 5 }));
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })] });
    await mount();
    const icons = rowsOf()[0]!.querySelector("[data-testid=pair-token-icons]")!;
    expect(icons.className).toContain("h-8 w-8");
    expect(icons.querySelectorAll(":scope > span")).toHaveLength(2);
  });

  it("the hero search reports how many pools in the full list match and does not filter the top 5", async () => {
    mocks.aprFor.mockImplementation(() => ready({ micro: 5 }));
    jsonOk({ pairs: [
      pair({ poolAddress: "spcx-pool" }),
      pair({ poolAddress: "tsla-pool", symbolA: "TSLAx", symbolB: "TSLA", wrappedSymbol: "TSLAx", plainSymbol: "TSLA", nameA: "Tesla xStock", nameB: "Tesla", tvlUsd: 90_000 }),
    ] });
    await mount();
    const hero = container.querySelector<HTMLInputElement>("#hero-search")!;
    expect(hero.getAttribute("placeholder")).toBe("Search SPCX, TSLA, AAPL…");
    await typeInto(hero, "tesla");
    expect(container.querySelector("[data-testid=hero-search-matches]")!.textContent).toContain("1 pool matches");
    expect(keysOf()).toEqual([sol("spcx-pool"), sol("tsla-pool")]);
  });

  it("renders the server snapshot at once, refreshes it from the API, and keeps it when the refresh fails", async () => {
    const initial = toHomepagePoolsSnapshot({
      solana: { pairs: [pair({ poolAddress: "spcx-pool" }) as HomepageSolanaRow], fetchedAt: "2026-10-30T11:02:00.000Z", stale: false },
      rhc: { pools: [rhcSummary(0, 50_000)], fetchedAt: "2026-10-30T11:02:56.939Z", stale: false },
      apr7d: { "solana:spcx-pool": 12.6, [`robinhood:${UNIV4_RHC_ALLOWLISTED_POOLS[0]!.poolId.toLowerCase()}`]: 5 },
    });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      root.render(createElement(HomepageMarketView, { initialPools: initial }));
    });
    expect(container.textContent).not.toContain("Loading pool data");
    expect(container.textContent).toContain("SPCXx/SPCX");
    expect(aprOf(rowsOf().find((row) => row.getAttribute("data-pool") === sol("spcx-pool"))!).textContent).toBe("12.60%");
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
      root.render(createElement(HomepageMarketView, { initialPools: initial }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(container.textContent).toContain("SPCXx/SPCX");
    expect(container.textContent).toContain("SPCX/SPCXon");
    expect(container.textContent).not.toContain("offline");
    expect(container.textContent).toContain("Updated 2026-10-30 11:02 UTC");
  });

  it("lists Robinhood Chain pools next to Solana ones, with chain badges, protocol and the RHC open link", async () => {
    mocks.aprFor.mockImplementation((_poolId, protocol) => (protocol === "uniswap-v4-rhc" ? ready({ micro: 5, tight: 33, standard: 9, wide: 2 }) : ready({ micro: 8 })));
    jsonOk(
      { pairs: [pair({ poolAddress: "spcx-pool", tvlUsd: 256_900 })], fetchedAt: "2026-10-30T11:02:46.419Z", freshness: { snapshotAt: "2026-10-30T11:02:46.419Z", stale: false } },
      { pools: [rhcSummary(0, 52_000), rhcSummary(1, 300_000)], fetchedAt: "2026-10-29T11:05:00.000Z", snapshot: { stale: false } },
    );
    await mount();
    const rows = rowsOf();
    const nvda = UNIV4_RHC_ALLOWLISTED_POOLS[1]!;
    // RHC 33% beats Solana 8%; the two RHC pools tie on APR so higher TVL is first.
    expect(rows.map((row) => row.getAttribute("data-chain"))).toEqual(["robinhood", "robinhood", "solana"]);
    expect(rows[0]!.textContent).toContain("NVDA/NVDAon");
    expect([...rows[0]!.querySelectorAll("[data-testid='token-icon-fallback']")].map((node) => node.textContent)).toEqual(["N", "N"]);
    expect(rows[0]!.querySelector("[data-testid='chain-badge']")!.textContent).toBe("Robinhood Chain");
    expect(rows[2]!.querySelector("[data-testid='chain-badge']")!.textContent).toBe("Solana");
    expect(rows[0]!.textContent).toContain("Uniswap v4");
    expect(rows[2]!.textContent).toContain("Raydium");
    expect(aprOf(rows[0]!).textContent).toBe("33.00%");
    expect(mocks.aprFor).toHaveBeenCalledWith(nvda.poolId, "uniswap-v4-rhc");
    expect(mocks.aprFor).toHaveBeenCalledWith("spcx-pool", "raydium-clmm");
    expect(rows[0]!.querySelector("a[href^='/app/rwa-pairs']")!.getAttribute("href")).toBe(`/app/rwa-pairs?openPool=${nvda.poolId}`);
    expect(rows[2]!.querySelector("a[href^='/app/rwa-pairs']")!.getAttribute("href")).toBe("/app/rwa-pairs?openPool=spcx-pool");
    expect(container.querySelector("[data-testid='homepage-pools-updated']")!.textContent).toBe(
      "Updated 2026-10-30 11:02 UTC (Solana) · 2026-10-29 11:05 UTC (Robinhood Chain)",
    );
  });

  it("keeps an Orca pool's Open disabled (openUi none) and an RHC pool a deep link", async () => {
    mocks.aprFor.mockImplementation(() => ready({ micro: 5, tight: 22, standard: 8, wide: 2 }));
    jsonOk(
      { pairs: [pair({ poolAddress: "orca-pool", protocol: "orca-whirlpool" })] },
      { pools: [rhcSummary(0, 52_000)], fetchedAt: "2026-10-29T11:05:00.000Z", snapshot: { stale: false } },
    );
    await mount();
    const orca = rowsOf().find((row) => row.getAttribute("data-pool") === sol("orca-pool"));
    expect(orca).toBeTruthy();
    expect(orca!.textContent).toContain("Orca");
    expect(orca!.getAttribute("data-testid")).toBe("top-pool-unavailable");
    expect(orca!.querySelector("a[href^='/app/rwa-pairs']")).toBeNull();
    const rhc = rowsOf().find((row) => row.getAttribute("data-pool") === rhcKey(0));
    expect(rhc).toBeTruthy();
    expect(rhc!.querySelector("a[href^='/app/rwa-pairs']")!.getAttribute("href")).toBe(`/app/rwa-pairs?openPool=${UNIV4_RHC_ALLOWLISTED_POOLS[0]!.poolId}`);
  });

  it("keeps showing the Solana rows when only the Robinhood Chain request fails", async () => {
    mocks.aprFor.mockImplementation(() => ready({ micro: 10 }));
    fetchMock.mockImplementation(async (url: string) => url === RHC_URL
      ? { ok: false, json: async () => ({ error: "down" }) }
      : { ok: true, json: async () => ({ pairs: [pair({ poolAddress: "spcx-pool" })] }) });
    await mount();
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(rowsOf()).toHaveLength(1);
  });

  it("keeps the highest 7-day APR pool per pair, even with less TVL, and shows tiny APRs as <0.01%", async () => {
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
    expect(keysOf()).toEqual([sol("spcx-small"), sol("tiny-pool"), sol("zero-pool")]);
    expect(rowsOf().map((row) => aprOf(row).textContent)).toEqual(["30.00%", "<0.01%", "0.00%"]);
    expect(container.querySelector("[data-testid=homepage-view-all]")!.textContent).toBe("See all 4 pools →");
  });

  it("a new pool (under 7 days of data) is excluded from the top 5 even with a high server APR", async () => {
    const young = cardPayloadWithAprs({ micro: 122.84 });
    young.sample = { ...young.sample, days: 6 };
    mocks.aprFor.mockImplementation((poolId) => (poolId === "amzn-pool" ? { status: "ready", data: young }
      : ready({ micro: poolId === "b-pool" ? 31.85 : 15.27 })));
    const pairs = [
      pair({ poolAddress: "amzn-pool", symbolA: "AMZNx", symbolB: "AMZN", tvlUsd: 900_000 }),
      pair({ poolAddress: "b-pool", symbolA: "Bx", symbolB: "B", tvlUsd: 800_000 }),
      pair({ poolAddress: "c-pool", symbolA: "Cx", symbolB: "C", tvlUsd: 700_000 }),
    ];
    jsonOk({ pairs });
    const initial = toHomepagePoolsSnapshot({
      solana: { pairs: pairs as HomepageSolanaRow[], fetchedAt: "2026-10-30T11:02:00.000Z", stale: false },
      apr7d: { "solana:amzn-pool": 500, "solana:b-pool": 31.85, "solana:c-pool": 15.27 },
    });
    await act(async () => {
      root.render(createElement(HomepageMarketView, { initialPools: initial }));
    });
    for (let round = 0; round < 4; round += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    expect(keysOf()).toEqual([sol("b-pool"), sol("c-pool")]);
    expect(container.textContent).not.toMatch(/122\.84|500/);
    expect(container.querySelector("[data-testid=homepage-view-all]")!.textContent).toBe("See all 3 pools →");
  });

  it("uses the server snapshot's 7-day APRs to pick, order, and print the top 5 until the client estimates load", async () => {
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
      root.render(createElement(HomepageMarketView, { initialPools: initial }));
    });
    expect(keysOf()).toEqual([sol("spcx-small"), sol("mstr-pool")]);
    expect(rowsOf().map((row) => aprOf(row).textContent)).toEqual(["30.00%", "<0.01%"]);
  });
});

it("disables homepage Open links when the shared native declaration is unavailable", async () => {
  mocks.nativeOpenDisabled = true;
  mocks.aprFor.mockImplementation(() => ready({ micro: 20, tight: 20, standard: 20, wide: 20 }));
  jsonOk({ pairs: [pair({ poolAddress: "spcx-pool", tvlUsd: 20_000 })], freshness: { snapshotAt: new Date().toISOString(), stale: false } });
  await mount();
  expect(keysOf()).toEqual([sol("spcx-pool")]);
  expect(rowsOf()[0]!.querySelector("a[aria-label^='Open position']")).toBeNull();
  expect(container.querySelector("[title='Native opening is unavailable']")).not.toBeNull();
});
