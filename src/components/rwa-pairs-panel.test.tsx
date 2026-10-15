// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { degradedPayloadFixture, payloadFixture, payloadWithAprs } from "../lib/range-apr/payload.fixture";
import { RwaPairsPanel } from "./rwa-pairs-panel";
import type { PoolRangeAprState } from "./range-apr/use-pool-range-apr";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  aprFor: vi.fn<(poolId: string) => PoolRangeAprState>(() => ({ status: "loading" })),
  tokens: {} as Record<string, { icon: string | null }>,
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./range-apr/use-pool-range-apr", () => ({ usePoolRangeApr: (poolId: string) => mocks.aprFor(poolId) }));
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
  mocks.tokens = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.startsWith("/api/token-metadata") ? { tokens: mocks.tokens } : {
      pairs: [
        { ...pair("poolone", "HOODx"), nameA: "Robinhood xStock", nameB: "Robinhood Markets - Backpack Securities" },
        pair("pooltwo", "SPCXx"),
      ],
      scannedPools: 2, pagesFetched: 1, fetchedAt: "now", pairingRuleSummary: "rule", estimatedFeeAprLabel: "label",
    },
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

describe("RwaPairsPanel pair cards", () => {
  const cards = () => [...container.querySelectorAll("ul > li")];
  const field = (card: number, testId: string) => cards()[card]!.querySelector(`[data-testid='${testId}']`)!;

  it("renders one card per pair with the Highest range APR as the headline and the range as its own field", async () => {
    mocks.aprFor.mockImplementation((poolId) =>
      poolId === "poolone" ? { status: "ready", data: payloadWithAprs({ micro: 10, tight: 38, standard: 20, wide: 5 }) } : { status: "loading" });
    await mount();
    expect(cards()).toHaveLength(2);
    expect(container.querySelector("table")).toBeNull();
    expect(cards()[0]!.querySelector("h3")!.textContent).toBe("HOODx/X");
    expect(field(0, "highest-range-apr").textContent).toBe("38%");
    expect(field(0, "highest-range-apr").parentElement!.textContent).toBe("38%APR");
    expect(field(0, "highest-range").textContent).toBe("Tight (±0.05%)");
    expect(field(0, "pool-fee-apr").textContent).toBe("12.34%");
    expect(cards()[0]!.querySelectorAll("[data-testid='highest-range-apr']")).toHaveLength(1);
    expect(cards()[0]!.textContent).not.toMatch(/Raydium APR|Daily APR/);
    expect(field(1, "highest-range").textContent).toBe("…");
    expect(field(1, "highest-range-apr").textContent).toBe("…");
    expect(field(1, "highest-range-apr").parentElement!.textContent).toBe("…");
    expect(container.textContent).not.toMatch(/APY|Best/);
    expect(container.querySelector("li svg.recharts-surface, li canvas")).toBeNull();
  });

  it("keeps the range label free of any APR figure", async () => {
    mocks.aprFor.mockImplementation(() => ({ status: "ready", data: payloadWithAprs({ micro: 148, tight: 4, standard: 3, wide: 2 }) }));
    await mount();
    expect(field(0, "highest-range").textContent).toBe("Micro");
    expect(field(0, "highest-range").textContent).not.toMatch(/%\s*APR|~/);
    expect(field(0, "highest-range-apr").textContent).toBe("148%");
  });

  it("shows the same range and number as the modal's Best for the same pool payload", async () => {
    const data = payloadWithAprs({ micro: 3, tight: 4, standard: 61, wide: 5 });
    mocks.aprFor.mockImplementation(() => ({ status: "ready", data }));
    await mount();
    const { buildPresetList } = await import("../lib/range-apr/preset-list");
    const { OPEN_RANGE_UI_PRESETS } = await import("@sofinance/engine/open-range-presets");
    const { formatEstimate } = await import("../lib/range-apr/format");
    const best = buildPresetList(OPEN_RANGE_UI_PRESETS, data).best!;
    expect(field(0, "highest-range").textContent).toBe(OPEN_RANGE_UI_PRESETS.find((preset) => preset.id === best.id)!.label);
    expect(field(0, "highest-range").textContent).toContain(best.resolvedLabel);
    expect(`~${field(0, "highest-range-apr").textContent}`).toBe(formatEstimate(best.estimate));
  });

  it("shows a bare APR figure even for a low-confidence sample, and a dash when no range could be priced", async () => {
    const low = payloadWithAprs({ standard: 61 });
    mocks.aprFor.mockImplementation((poolId) => poolId === "poolone"
      ? { status: "ready", data: { ...low, sample: { ...low.sample, confidence: "low" } } }
      : { status: "ready", data: payloadWithAprs({ micro: null, tight: null, standard: null, wide: null }) });
    await mount();
    expect(field(0, "highest-range-apr").textContent).toMatch(/^\d+%$/);
    expect(cards()[0]!.textContent).not.toMatch(/[~*]/);
    expect(field(1, "highest-range").textContent).toBe("—");
    expect(field(1, "highest-range-apr").textContent).toBe("—");
  });

  it("shows each token's Jupiter icon, wrapped token first, falling back to Raydium's when Jupiter has none", async () => {
    mocks.tokens = { a: { icon: "https://static.jup.ag/a.png" }, b: { icon: null } };
    await mount();
    const icons = [...cards()[0]!.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(icons).toEqual(["https://static.jup.ag/a.png", "https://img-v1.raydium.io/icon/b.png"]);
  });

  it("shortens the names under the pair to company + issuers and keeps the full names as a tooltip", async () => {
    await mount();
    const subtitle = (card: number) => cards()[card]!.querySelector("h3 + p")!;
    expect(subtitle(0).textContent).toBe("Robinhood xStock / Backpack");
    expect(subtitle(0).getAttribute("title")).toBe("Robinhood xStock / Robinhood Markets - Backpack Securities");
    expect(subtitle(1).textContent).toBe("A / B");
  });

  it("links the pool address to that pool on Raydium in a new tab", async () => {
    await mount();
    const link = cards()[0]!.querySelector<HTMLAnchorElement>("a[target='_blank']")!;
    expect(link.getAttribute("href")).toBe("https://raydium.io/clmm/create-position/?pool_id=poolone");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(link.className).toContain("underline");
  });

  it("lays the cards out in a grid that wraps instead of scrolling horizontally", async () => {
    mocks.aprFor.mockImplementation(() => ({ status: "ready", data: payloadFixture() }));
    await mount();
    const list = container.querySelector("ul")!;
    expect(list.className).toContain("grid");
    expect(list.className).toContain("lg:grid-cols-2");
    expect(container.querySelector(".overflow-x-auto")).toBeNull();
  });

  it("shows a dash (no range, no number) for a degraded payload, with the reason on the pill's tooltip", async () => {
    mocks.aprFor.mockImplementation(() => ({ status: "ready", data: degradedPayloadFixture() }));
    await mount();
    for (const card of [0, 1]) {
      expect(field(card, "highest-range").textContent).toBe("—");
      expect(field(card, "highest-range-apr").textContent).toBe("—");
      expect(field(card, "highest-range-apr").parentElement!.textContent).not.toMatch(/APR|%/);
      expect(cards()[card]!.querySelector("button[aria-label='About Highest range APR']")).not.toBeNull();
    }
  });
});
