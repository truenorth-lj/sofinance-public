// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOMEPAGE_POOL_APR_LABEL } from "@/lib/apr-labels/copy";
import { RWA_PAIRS_LIST_PATH } from "@/lib/rwa-pairs-list";
import { HomepagePoolsTable } from "./homepage-pools-table";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

const pair = (overrides: Record<string, unknown>) => ({
  poolAddress: "pool",
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
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => body,
  });
}

describe("HomepagePoolsTable", () => {
  it("loads the shared /api/rwa-pairs cache, sorts by TVL, and deep-links Open position", async () => {
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
    expect(rows[0]!.textContent).toContain("12.60%");
    expect(table.textContent).toContain(HOMEPAGE_POOL_APR_LABEL);
    expect(rows[0]!.querySelector("a")!.getAttribute("href")).toBe(
      "/app/rwa-pairs?pool=spcx-pool&open=1",
    );
    expect(rows.some((row) => row.getAttribute("data-pool") === "sndk-pool")).toBe(false);
    expect(container.textContent).toContain("See all pools");
    expect(container.textContent).not.toMatch(/\byield\b|\bearn\b|recipe/i);
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
