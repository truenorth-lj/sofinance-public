// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIGHEST_RANGE_APR_7D_LABEL, HOMEPAGE_POOL_APR_LABEL } from "@/lib/apr-labels/copy";
import { payloadWithAprs } from "@/lib/range-apr/payload.fixture";
import { RWA_PAIRS_LIST_PATH } from "@/lib/rwa-pairs-list";
import { HomepagePoolsTable } from "./homepage-pools-table";
import type { PoolRangeAprState } from "./range-apr/use-pool-range-apr";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));
const mocks = vi.hoisted(() => ({
  aprFor: vi.fn<(poolId: string) => PoolRangeAprState>(() => ({ status: "loading" })),
  tokens: {} as Record<string, { icon: string | null }>,
}));
vi.mock("./range-apr/use-pool-range-apr", () => ({ usePoolRangeApr: (poolId: string) => mocks.aprFor(poolId) }));

const pair = (overrides: Record<string, unknown>) => ({
  poolAddress: "pool",
  mintA: "mint-wrapped",
  mintB: "mint-plain",
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

function jsonOk(body: unknown) {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url.startsWith("/api/token-metadata") ? { tokens: mocks.tokens } : body),
  }));
}

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
    expect(rows[0]!.querySelector("[data-testid='homepage-apr']")!.textContent).toBe("81%");
    expect(rows[0]!.textContent).not.toContain("12.60%");
    expect(HOMEPAGE_POOL_APR_LABEL).toBe(HIGHEST_RANGE_APR_7D_LABEL);
    expect(table.querySelector("thead")!.textContent).toContain("Est. highest range APR · 7d avg · not guaranteed");
    expect(table.querySelector("thead button[aria-label='About Est. highest range APR']")).not.toBeNull();
    const docsLink = table.querySelector("thead a[href='/docs/yield-and-apr']")!;
    expect(docsLink.textContent).toBe("APR details");
    expect(rows[0]!.querySelector("a[href^='/app/rwa-pairs']")!.getAttribute("href")).toBe(
      "/app/rwa-pairs?pool=spcx-pool&open=1",
    );
    expect(rows.some((row) => row.getAttribute("data-pool") === "sndk-pool")).toBe(false);
    expect(container.textContent).toContain("See all pools");
    expect(container.textContent).not.toMatch(/\byield\b|\bearn\b|make your money|strateg|recipe|open[- ]source|\bMIT\b/i);
  });

  it("shows the paired token logos from token metadata, wrapped token first, with the Raydium fallback", async () => {
    mocks.tokens = { "mint-wrapped": { icon: "https://static.jup.ag/spcxx.png" }, "mint-plain": { icon: null } };
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool" })] });
    await mount();
    expect(fetchMock).toHaveBeenCalledWith("/api/token-metadata", expect.objectContaining({ method: "POST" }));
    const row = container.querySelector('[data-testid="homepage-pools-table"] tbody tr')!;
    expect([...row.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "https://static.jup.ag/spcxx.png",
      "https://img-v1.raydium.io/icon/mint-plain.png",
    ]);
    const card = container.querySelector('[data-testid="homepage-pools-cards"] li')!;
    expect(card.querySelectorAll("img")).toHaveLength(2);
  });

  it("puts the plain-stock logo second when the pool lists the wrapped token as B", async () => {
    mocks.tokens = { "mint-wrapped": { icon: "https://static.jup.ag/w.png" }, "mint-plain": { icon: "https://static.jup.ag/p.png" } };
    jsonOk({ pairs: [pair({ poolAddress: "spcx-pool", mintA: "mint-plain", mintB: "mint-wrapped", symbolA: "SPCX", symbolB: "SPCXx" })] });
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
});
