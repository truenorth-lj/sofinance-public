// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadFixture, payloadWithAprs } from "../lib/range-apr/payload.fixture";
import { RwaPairsPanel } from "./rwa-pairs-panel";
import type { PoolRangeAprState } from "./range-apr/use-pool-range-apr";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ aprFor: vi.fn<(poolId: string) => PoolRangeAprState>(() => ({ status: "loading" })) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./range-apr/use-pool-range-apr", () => ({ usePoolRangeApr: (poolId: string) => mocks.aprFor(poolId) }));
vi.mock("./pool-daily-apr-panel", () => ({ PoolAprSparkline: () => createElement("span", null, "spark") }));
vi.mock("./open-position-modal", () => ({ OpenPositionModal: () => null }));

const pair = (poolAddress: string, wrappedSymbol: string) => ({
  poolAddress, mintA: "a", mintB: "b", symbolA: wrappedSymbol, symbolB: "X", nameA: "A", nameB: "B",
  baseSymbol: "X", wrappedSymbol, plainSymbol: "X", feeTierBps: 1, tvlUsd: 1000, volume24hUsd: 100, fees24hUsd: 1,
  raydiumFeeApr24h: 5, estimatedFeeAprPct: 12.34, token2022A: false, token2022B: false, freezeRisk: false, relatedness: "same",
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({
      pairs: [pair("poolone", "HOODx"), pair("pooltwo", "SPCXx")], scannedPools: 2, pagesFetched: 1, fetchedAt: "now",
      pairingRuleSummary: "rule", estimatedFeeAprLabel: "label",
    }),
  })));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => { root.render(createElement(RwaPairsPanel)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

describe("RwaPairsPanel Highest range column", () => {
  const headers = () => [...container.querySelectorAll("thead th")].map((th) => th.textContent);
  const cellOf = (row: number) => container.querySelectorAll("tbody tr")[row]!.querySelectorAll("td")[2]!;

  it("adds a 'Highest range' column right after Est. fee APR and leaves the Est. fee APR cell untouched", async () => {
    mocks.aprFor.mockImplementation((poolId) =>
      poolId === "poolone" ? { status: "ready", data: payloadWithAprs({ micro: 10, tight: 38, standard: 20, wide: 5 }) } : { status: "loading" });
    await mount();
    expect(headers().slice(0, 3)).toEqual(["Pair", "Est. fee APR", "Highest range"]);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelectorAll("td")[1]!.textContent).toBe("12.34%");
    expect(cellOf(0).textContent).toBe("Tight · ~38% APR");
    expect(cellOf(1).textContent).toBe("…");
    expect(container.textContent).not.toMatch(/APY|AI-pick/);
    expect(container.querySelector("tbody svg.recharts-surface, tbody canvas")).toBeNull();
  });

  it("shows the same range and number as the modal's AI best for the same pool payload", async () => {
    const data = payloadWithAprs({ micro: 3, tight: 4, standard: 61, wide: 5 });
    mocks.aprFor.mockImplementation(() => ({ status: "ready", data }));
    await mount();
    const { buildPresetList } = await import("../lib/range-apr/preset-list");
    const { OPEN_RANGE_UI_PRESETS } = await import("../lib/open-range-presets");
    const { formatEstimate } = await import("../lib/range-apr/format");
    const best = buildPresetList(OPEN_RANGE_UI_PRESETS, data).aiBest!;
    expect(container.querySelector("[data-testid='highest-range']")!.textContent)
      .toBe(`${best.resolvedLabel} · ${formatEstimate(best.estimate)} APR`);
  });

  it("flags low confidence and shows a dash when no range could be priced", async () => {
    const low = payloadWithAprs({ standard: 61 });
    mocks.aprFor.mockImplementation((poolId) => poolId === "poolone"
      ? { status: "ready", data: { ...low, sample: { ...low.sample, confidence: "low" } } }
      : { status: "ready", data: payloadWithAprs({ micro: null, tight: null, standard: null, wide: null }) });
    await mount();
    expect(cellOf(0).textContent).toMatch(/^Micro · ~\d+% APR\*$|^Standard · ~61% APR\*$/);
    expect(cellOf(1).textContent).toBe("—");
  });

  it("stays a table cell that scrolls horizontally on narrow screens (no wrapping)", async () => {
    mocks.aprFor.mockImplementation(() => ({ status: "ready", data: payloadFixture() }));
    await mount();
    expect(container.querySelector("table")!.parentElement!.className).toContain("overflow-x-auto");
    expect(cellOf(0).firstElementChild!.className).toContain("whitespace-nowrap");
  });
});
