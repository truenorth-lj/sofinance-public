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

/** The full list (every pool) and the Top Pools card (the top 5 above the TVL floor). */
const rowsOf = () => [...container.querySelectorAll('[data-testid="homepage-pools-table"] tbody tr')];
const keysOf = () => rowsOf().map((row) => row.getAttribute("data-pool"));
const cardRowsOf = () => [...container.querySelectorAll('[data-testid="top-pools-card"] li[data-pool]')];
const cardKeysOf = () => cardRowsOf().map((row) => row.getAttribute("data-pool"));
const cardAprOf = (row: Element) => row.querySelector("[data-testid='top-pool-apr']")!.textContent;
const statusText = () => [...container.querySelectorAll("[role='status']")].map((node) => node.textContent).join(" | ");
/** Types into a search box the way React sees it (native setter + input event). */
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const aprOf = (row: Element) => row.querySelector("[data-testid='apr7d']")!;
const sol = (address: string) => `solana:${address}`;
const rhcKey = (index: number) => `robinhood:${UNIV4_RHC_ALLOWLISTED_POOLS[index]!.poolId.toLowerCase()}`;
const ready = (aprs: Parameters<typeof cardPayloadWithAprs>[0]): PoolRangeAprState => ({ status: "ready", data: cardPayloadWithAprs(aprs) });

describe("homepage pools: Top Pools card and the full list", () => {
  it("renders the /app/rwa-pairs list view (same PoolTable, sortable), loads the shared /api/rwa-pairs cache and deep-links Open", async () => {
    mocks.aprFor.mockImplementation((poolId) => (poolId === "spcx-pool" ? ready({ micro: 10, tight: 81, standard: 20, wide: 5 }) : { status: "loading" }));
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })], freshness: { snapshotAt: new Date().toISOString(), stale: false } });
    await mount();

    expect(fetchMock).toHaveBeenCalledWith(RWA_PAIRS_LIST_PATH, expect.objectContaining({ headers: { Accept: "application/json" } }));
    const table = container.querySelector('[data-testid="homepage-pools-table"] table')!;
    expect(table.getAttribute("data-testid")).toBe("homepage-pools-list");
    expect(container.querySelector("#pools #homepage-pools-heading")!.textContent).toBe("All pools");
    const [row] = rowsOf();
    expect(row!.getAttribute("data-pool")).toBe(sol("spcx-pool"));
    expect(row!.textContent).toContain("SPCXx/SPCX");
    expect(row!.textContent).toContain("$256.9k");
    expect(aprOf(row!).textContent).toBe("81.00%");
    expect(row!.querySelector("[data-testid='chain-badge']")!.textContent).toBe("Solana");
    // Same columns as the /app/rwa-pairs list view, sortable like it; one estimate column (no 24h fee APR).
    const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(headers.slice(0, 6)).toEqual(["Pool", "Chain", "Protocol", "Est. APR 7d", "TVL", "24h vol"]);
    expect(headers).not.toContain("Risk");
    expect(table.textContent).not.toMatch(/Freeze risk|Token-2022|No flags/);
    expect(table.querySelector("thead [aria-sort='descending']")!.textContent).toBe("Est. APR 7d");
    expect(table.querySelectorAll("thead button:not([aria-label^='About'])")).toHaveLength(6);
    expect(row!.querySelector("a[aria-label='Open position in SPCXx/SPCX']")!.getAttribute("href")).toBe("/app/rwa-pairs?openPool=spcx-pool");
    // The Top Pools card lists it too: the whole row is the Open link (no separate button), the estimate as plain text.
    const [card] = cardRowsOf();
    expect(card!.textContent).toContain("Raydium · Solana");
    expect(cardAprOf(card!)).toBe("81.00%");
    expect(card!.querySelectorAll("a")).toHaveLength(1);
    expect(card!.querySelector("a")!.getAttribute("href")).toBe("/app/rwa-pairs?openPool=spcx-pool");
    expect(card!.querySelector("a")!.textContent).toContain("SPCXx/SPCX");
    expect(card!.querySelectorAll("button")).toHaveLength(0);
    const viewAll = container.querySelector("[data-testid='homepage-view-all']")!;
    expect(viewAll.getAttribute("href")).toBe("/app/rwa-pairs");
    expect(viewAll.textContent).toBe("Open in app →");
    expect(container.querySelector("a[href='/docs/fee-apr']")!.textContent).toBe("How estimates work");
    expect(container.querySelector("#pools a[href='/docs/risks']")!.textContent).toBe("Risks");
    expect(container.textContent).not.toMatch(/\byield\b|\bearn\b|make your money|strateg|recipe|open[- ]source|\bMIT\b/i);
  });

  it("opens a Meteora pool in its /app/rwa-pairs dialog (?openPool=), like the pools page does (list and card)", async () => {
    mocks.aprFor.mockImplementation((poolId) => (poolId === "met-pool" ? ready({ micro: 10, tight: 30, standard: 20, wide: 5 }) : { status: "loading" }));
    jsonOk({ pairs: [pair({ poolAddress: "met-pool", protocol: "meteora-dlmm" })], freshness: { snapshotAt: new Date().toISOString(), stale: false } });
    await mount();
    const [row] = rowsOf();
    expect(row!.getAttribute("data-pool")).toBe(sol("met-pool"));
    expect(row!.querySelector("[data-testid=protocol-badge]")!.textContent).toBe("Meteora");
    expect(row!.querySelector("[data-testid=open-disabled]")).toBeNull();
    expect(row!.textContent).not.toContain("isn't available yet");
    expect(row!.querySelector("a[aria-label='Open position in SPCXx/SPCX']")!.getAttribute("href")).toBe("/app/rwa-pairs?openPool=met-pool");
    const [card] = cardRowsOf();
    expect(card!.textContent).toContain("Meteora · Solana");
    expect(card!.querySelector("a")!.getAttribute("href")).toBe("/app/rwa-pairs?openPool=met-pool");
  });

  it("leaves out a pool whose token is not supported yet (NVDAx, ScaledUiAmount): not in Top Pools, not in the list, its APR never read", async () => {
    mocks.aprFor.mockImplementation((poolId) => (poolId === "nvda-pool" ? ready({ micro: 300, tight: 300, standard: 300, wide: 300 })
      : poolId === "spcx-pool" ? ready({ micro: 10, tight: 10, standard: 10, wide: 10 }) : { status: "loading" }));
    jsonOk({ pairs: [
      pair({ poolAddress: "nvda-pool", symbolA: "NVDAx", symbolB: "NVDA", wrappedSymbol: "NVDAx", plainSymbol: "NVDA", tvlUsd: 10_500,
        unsupported: { issues: ["ScaledUiAmount multiplier not 1"], mints: ["nvdax"] } }),
      pair({ poolAddress: "spcx-pool", tvlUsd: 20_000 }),
    ], freshness: { snapshotAt: new Date().toISOString(), stale: false } });
    await mount();
    // Even with the highest APR it is not listed anywhere on the homepage (/app/rwa-pairs still shows it, greyed).
    expect(keysOf()).toEqual([sol("spcx-pool")]);
    expect(cardKeysOf()).toEqual([sol("spcx-pool")]);
    expect(container.textContent).not.toContain("NVDAx/NVDA");
    expect(container.textContent).not.toContain("Not supported yet");
    expect(container.querySelector("[data-testid=open-unsupported]")).toBeNull();
    expect(mocks.aprFor.mock.calls.some(([poolId]) => poolId === "nvda-pool")).toBe(false);
    expect(container.querySelector("[data-testid=homepage-pools-count]")!.textContent).toBe("1 pool.");
  });

  it("merges both chains by 7-day APR (high to low): Top Pools shows 5, the list shows every pool", async () => {
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
    expect(cardKeysOf()).toEqual([sol("a-pool"), sol("b-pool"), rhcKey(1), sol("c-pool"), sol("e-pool")]);
    expect(cardRowsOf().map(cardAprOf)).toEqual(["103.50%", "31.85%", "20.00%", "15.27%", "4.72%"]);
    expect(cardRowsOf()[2]!.textContent).toContain("Uniswap v4 · Robinhood Chain");
    expect(keysOf()).toEqual([sol("a-pool"), sol("b-pool"), rhcKey(1), sol("c-pool"), sol("e-pool"), rhcKey(0), sol("d-pool"), sol("f-pool")]);
    expect(rowsOf().map((row) => aprOf(row).textContent)).toEqual(["103.50%", "31.85%", "20.00%", "15.27%", "4.72%", "0.50%", "0.05%", "—"]);
    expect(rowsOf()[2]!.querySelector("[data-testid='chain-badge']")!.textContent).toBe("Robinhood Chain");
    expect(container.querySelector("[data-testid=homepage-pools-count]")!.textContent).toBe("8 pools.");
  });

  it("Top Pools leaves out pools under $5k TVL before the duplicate rule; the list is /app/rwa-pairs' default view (no floor)", async () => {
    const apr: Record<string, number> = { "meta-tiny": 673.66, "meta-big": 40, "tsla-pool": 20, "small-pool": 300 };
    mocks.aprFor.mockImplementation((poolId) => (apr[poolId] !== undefined ? ready({ micro: apr[poolId]! }) : { status: "error", message: "down" }));
    jsonOk({ pairs: [
      pair({ poolAddress: "meta-tiny", symbolA: "METAx", symbolB: "META", mintA: "meta-x", mintB: "meta", tvlUsd: 1_023.91 }),
      pair({ poolAddress: "meta-big", symbolA: "METAx", symbolB: "META", mintA: "meta-x", mintB: "meta", tvlUsd: 48_000 }),
      pair({ poolAddress: "tsla-pool", symbolA: "TSLAx", symbolB: "TSLA", tvlUsd: 5_000 }),
      pair({ poolAddress: "small-pool", symbolA: "AMDx", symbolB: "AMD", tvlUsd: 4_999 }),
    ] });
    await mount();
    const card = container.querySelector("[data-testid=top-pools-card]")!;
    expect(card.textContent).toContain("Pools over $5k TVL, by best range APR.");
    expect(card.textContent).toContain("Best range · 7d");
    expect(cardKeysOf()).toEqual([sol("meta-big"), sol("tsla-pool")]);
    // The number is the best range's APR, the same state the pool's card shows; the tooltip and screen readers name the range.
    const firstApr = cardRowsOf()[0]!.querySelector("[data-testid=top-pool-apr]")!;
    expect(firstApr.textContent).toBe("40.00%");
    expect(firstApr.getAttribute("title")).toMatch(/^Best range: Micro\. Estimated from the past 7 days/);
    expect(cardRowsOf()[0]!.textContent).toContain(", Micro range");
    // Every listed pool's APR is requested.
    expect(mocks.aprFor.mock.calls.map(([poolId]) => poolId).sort()).toEqual(["meta-big", "meta-tiny", "small-pool", "tsla-pool"]);
    // Like /app/rwa-pairs with no TVL filter: the higher-APR tiny pool keeps the pair, Low TVL pools rank after bigger ones.
    expect(keysOf()).toEqual([sol("tsla-pool"), sol("meta-tiny"), sol("small-pool")]);
    expect(rowsOf()[1]!.querySelector("[data-testid=low-tvl-tag]")).toBeTruthy();
    expect(container.querySelector("[data-testid=homepage-pools-count]")!.textContent).toBe("3 pools · 1 duplicate pool of the same pair hidden.");
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
    expect(cardRowsOf().map(cardAprOf)).toEqual(["…", "—", "—"]);
  });

  it("shows a loading status before pairs arrive", async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      root.render(createElement(HomepageMarket));
    });
    expect(statusText()).toMatch(/Loading pool data/);
    expect(statusText()).toMatch(/Loading stock data/);
    // Placeholder rows of the final row height hold each card's size, so nothing below moves when data arrives.
    for (const card of ["stock-card-gainers", "stock-card-stocks", "top-pools-card"]) {
      const rows = container.querySelectorAll(`[data-testid=${card}] [data-testid=market-rows-skeleton] li[aria-hidden=true]`);
      expect(rows, card).toHaveLength(5);
      expect(rows[0]!.className, card).toContain("min-h-16");
    }
  });

  it("surfaces an error with a retry control", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "Snapshot unavailable" }) });
    await mount();
    expect(container.querySelector("[role='alert']")!.textContent).toContain("Snapshot unavailable");
    expect(container.querySelector("[role='alert'] button")!.textContent).toBe("Try again");
    expect(container.querySelector("[data-testid=top-pools-card]")!.textContent).toContain("Pools could not be loaded right now.");
  });

  it("handles an empty pair list", async () => {
    jsonOk({ pairs: [] });
    await mount();
    expect(container.textContent).toMatch(/No pools to show/);
    expect(container.querySelector("[data-testid='homepage-view-all']")!.getAttribute("href")).toBe("/app/rwa-pairs");
  });

  it("marks a highlighted pool from a tweet deep link in the full list", async () => {
    mocks.aprFor.mockImplementation((poolId) => (poolId === "hood-pool" ? { status: "error", message: "down" } : ready({ micro: 5 })));
    jsonOk({ pairs: [
      ...["a", "b", "c", "d", "e"].map((id) => pair({ poolAddress: `${id}-pool` })),
      pair({ poolAddress: "hood-pool", wrappedSymbol: "HOODx", plainSymbol: "HOOD", tvlUsd: 80_000 }),
    ] });
    await mount("hood-pool");
    expect(keysOf()).toHaveLength(6);
    expect(keysOf().at(-1)).toBe(sol("hood-pool"));
    expect(cardKeysOf()).not.toContain(sol("hood-pool"));
    const marked = container.querySelectorAll('[data-highlighted="true"]');
    expect([...marked].map((node) => node.getAttribute("data-pool"))).toEqual([sol("hood-pool")]);
  });

  it("Enter in the hero search hands the cursor to the list's search box, caret at the end", async () => {
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })] });
    await mount();
    const scrolled = vi.fn();
    container.querySelector<HTMLElement>("#pools")!.scrollIntoView = scrolled;
    const hero = container.querySelector<HTMLInputElement>("#hero-search")!;
    hero.focus();
    await typeInto(hero, "spcx");
    await act(async () => { hero.form!.requestSubmit(); });
    expect(scrolled).toHaveBeenCalledTimes(1);
    const list = container.querySelector<HTMLInputElement>("#pools-search")!;
    expect(document.activeElement).toBe(list);
    expect(list.value).toBe("spcx");
    expect(list.selectionStart).toBe(4);
  });

  it("the line under the hero search grows out of the field only after typing, never on page load", async () => {
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })] });
    await mount();
    const line = () => container.querySelector("[data-testid=landing-hero] [aria-live=polite] > span")!;
    expect(line().textContent).toContain("0 keys on our servers");
    expect(line().className).not.toContain("animate-emerge");
    await typeInto(container.querySelector<HTMLInputElement>("#hero-search")!, "spcx");
    expect(line().textContent).toContain("1 pool matches");
    expect(line().className).toContain("motion-safe:animate-emerge");
  });

  it("nests the cards' corners from the outside in (28px card, 16px padding → 12px panel → 8px rows); both searches are pills", async () => {
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })] });
    await mount();
    for (const id of ["stock-card-gainers", "stock-card-stocks", "top-pools-card"]) {
      const card = container.querySelector<HTMLElement>(`[data-testid=${id}]`)!;
      expect(card.className, id).toMatch(/\brounded-surface\b.*\bp-4\b.*\[--radius-inset:0\.75rem\]/);
      expect(card.className, id).not.toMatch(/\bsm:p-/);
      const panel = card.querySelector("ol")!;
      expect(panel.className, id).toMatch(/\brounded-inset\b.*\bp-1\b/);
      // The row frame (an <li>, or the link inside a Top Pools <li>), loaded or placeholder.
      expect(panel.querySelector(".min-h-16")!.className, id).toMatch(/\brounded-lg\b.*\bpy-2\b/);
    }
    expect(container.querySelector("#hero-search")!.parentElement!.className).toMatch(/\brounded-full\b/);
    expect(container.querySelector("#pools-search")!.parentElement!.className).toMatch(/\brounded-full\b/);
    // Both search fields keep 16px text on phones: iOS zooms the page in when a smaller field is focused.
    expect(container.querySelector("#hero-search")!.className).toMatch(/(^|\s)text-base(\s|$)/);
    expect(container.querySelector("#pools-search")!.className).toMatch(/(^|\s)text-base(\s|$)/);
  });

  it("Top Pools rows show the pair as one stacked 32 px icon, so names start where the stock names do", async () => {
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })] });
    await mount();
    const icons = cardRowsOf()[0]!.querySelector("[data-testid=pair-token-icons]")!;
    expect(icons.className).toContain("h-8 w-8");
    expect(icons.querySelectorAll(":scope > span")).toHaveLength(2);
    // The list keeps the side-by-side pair.
    expect(rowsOf()[0]!.querySelector("[data-testid=pair-token-icons]")!.className).toContain("-space-x-3");
  });

  it("the hero search filters the list, says how many pools match, and shares its query with the list's search", async () => {
    mocks.aprFor.mockImplementation(() => ready({ micro: 5 }));
    jsonOk({ pairs: [
      pair({ poolAddress: "spcx-pool" }),
      pair({ poolAddress: "tsla-pool", symbolA: "TSLAx", symbolB: "TSLA", wrappedSymbol: "TSLAx", plainSymbol: "TSLA", nameA: "Tesla xStock", nameB: "Tesla", tvlUsd: 90_000 }),
    ] });
    await mount();
    const hero = container.querySelector<HTMLInputElement>("#hero-search")!;
    expect(hero.getAttribute("placeholder")).toBe("Search SPCX, TSLA, AAPL…");
    await typeInto(hero, "tesla");
    expect(keysOf()).toEqual([sol("tsla-pool")]);
    expect(container.querySelector("[data-testid=hero-search-matches]")!.textContent).toContain("1 pool matches");
    const listSearch = container.querySelector<HTMLInputElement>("#pools input[type=search]")!;
    expect(listSearch.value).toBe("tesla");
    // The cards are not filtered: Top Pools still shows the top pools.
    expect(cardKeysOf()).toHaveLength(2);
    await typeInto(listSearch, "zzz");
    expect(rowsOf()).toHaveLength(0);
    expect(container.querySelector("[data-testid=homepage-pools-empty]")!.textContent).toContain("No pools match “zzz”.");
    await act(async () => { container.querySelector<HTMLButtonElement>("[data-testid=homepage-pools-empty] button")!.click(); });
    expect(keysOf()).toHaveLength(2);
    expect(hero.value).toBe("");
  });

  it("sorts the list by a column header, like /app/rwa-pairs", async () => {
    mocks.aprFor.mockImplementation((poolId) => ready({ micro: poolId === "a-pool" ? 50 : 10 }));
    jsonOk({ pairs: [
      pair({ poolAddress: "a-pool", tvlUsd: 10_000 }),
      pair({ poolAddress: "b-pool", symbolA: "Bx", symbolB: "B", tvlUsd: 90_000 }),
    ] });
    await mount();
    expect(keysOf()).toEqual([sol("a-pool"), sol("b-pool")]);
    const tvl = [...container.querySelectorAll<HTMLButtonElement>("[data-testid=homepage-pools-list] thead button")].find((button) => button.textContent === "TVL")!;
    await act(async () => { tvl.click(); });
    expect(keysOf()).toEqual([sol("b-pool"), sol("a-pool")]);
    expect(container.querySelector("[data-testid=homepage-pools-list] thead [aria-sort='descending']")!.textContent).toBe("TVL");
  });

  it("renders the server snapshot at once, refreshes it from the API, and keeps it when the refresh fails", async () => {
    const initial = toHomepagePoolsSnapshot({
      solana: { pairs: [pair({ poolAddress: "spcx-pool" }) as HomepageSolanaRow], fetchedAt: "2026-10-30T11:02:00.000Z", stale: false },
      rhc: { pools: [rhcSummary(0, 50_000)], fetchedAt: "2026-10-30T11:02:56.939Z", stale: false },
    });
    fetchMock.mockImplementation(() => new Promise(() => {})); // refresh never answers yet
    await act(async () => {
      root.render(createElement(HomepageMarketView, { initialPools: initial }));
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
    expect(rows[0]!.querySelector("[data-testid=open-disabled]")).toBeNull();
    expect(rows[2]!.querySelector("a[href^='/app/rwa-pairs']")!.getAttribute("href")).toBe("/app/rwa-pairs?openPool=spcx-pool");
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
    expect(cardKeysOf()).toEqual(keysOf());
    const apr = rowsOf().map(aprOf);
    expect(apr.map((cell) => cell.textContent)).toEqual(["30.00%", "<0.01%", "0.00%", "—"]);
    expect(cardRowsOf().map(cardAprOf)).toEqual(["30.00%", "<0.01%", "0.00%", "—"]);
  });

  it("a new pool (under 7 days of data) shows no APR, says how many days it has, and ranks last even with a high server APR", async () => {
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
    expect(keysOf()).toEqual([sol("b-pool"), sol("c-pool"), sol("amzn-pool")]);
    const amzn = rowsOf()[2]!;
    expect(aprOf(amzn).textContent).toBe("New pool");
    expect(aprOf(amzn).getAttribute("data-apr-status")).toBe("new");
    expect(amzn.querySelector("[data-testid='apr7d-new-days']")!.textContent).toBe("6 days of data");
    expect(amzn.textContent).not.toMatch(/122\.84|500/);
    expect(cardAprOf(cardRowsOf()[2]!)).toBe("New pool");
    expect(container.querySelector("[data-testid=top-pools-card]")!.textContent).not.toMatch(/122\.84|500/);
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
      root.render(createElement(HomepageMarketView, { initialPools: initial }));
    });
    expect(keysOf()).toEqual([sol("spcx-small"), sol("mstr-pool")]);
    expect(rowsOf().map((row) => aprOf(row).textContent)).toEqual(["…", "…"]);
    expect(cardKeysOf()).toEqual([sol("spcx-small"), sol("mstr-pool")]);
    expect(cardRowsOf().map(cardAprOf)).toEqual(["…", "…"]);
  });
});
