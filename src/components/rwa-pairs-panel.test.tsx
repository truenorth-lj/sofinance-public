// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payloadFixture } from "../lib/range-apr/payload.fixture";
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

describe("RwaPairsPanel AI-pick APR", () => {
  it("shows 'AI-pick est. APR' on the second row of each pair's Est. fee APR cell, in plain text", async () => {
    const data = payloadFixture();
    mocks.aprFor.mockImplementation((poolId) => (poolId === "poolone" ? { status: "ready", data } : { status: "loading" }));
    await mount();
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    const cell = rows[0]!.querySelectorAll("td")[1]!;
    const lines = [...cell.children].map((child) => child.textContent ?? "");
    expect(lines[0]).toBe("12.34%"); // row 1: the existing pool-level estimate
    expect(lines[1]).toMatch(/^AI-pick est\. APR~\d/); // row 2: the AI-pick estimate
    expect(cell.textContent).not.toMatch(/APY/);
    expect(rows[1]!.querySelectorAll("td")[1]!.textContent).toContain("AI-pick est. APR…");
    expect(container.querySelector("tbody svg.recharts-surface, tbody canvas")).toBeNull();
  });

  it("uses the same number as the modal's AI pick for the same pool payload", async () => {
    const data = payloadFixture();
    mocks.aprFor.mockImplementation(() => ({ status: "ready", data }));
    await mount();
    const { formatEstimate } = await import("../lib/range-apr/format");
    const expected = formatEstimate(data.presets.find((preset) => preset.id === "ai")!.estimate);
    expect(container.querySelector("[data-testid='ai-pick-apr']")!.textContent).toBe(expected);
  });
});
