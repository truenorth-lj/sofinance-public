// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { UnifiedPool } from "@/lib/unified-pools/model";
import type { Apr7dState } from "./use-pools-apr7d";
import { UnifiedPoolsPanel, type UnifiedPoolFlags } from "./unified-pools-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  apr: {} as Record<string, number>,
  connect: vi.fn(),
  connected: false,
  modal: vi.fn(),
}));
vi.mock("./use-pools-apr7d", () => ({
  usePoolsApr7d: (pools: UnifiedPool[]) => Object.fromEntries(pools.map((pool): [string, Apr7dState] => [pool.key,
    pool.poolAddress in mocks.apr ? { status: "ready", aprPct: mocks.apr[pool.poolAddress]! } : { status: "missing", reason: "No 7-day estimate" }])),
}));
vi.mock("../wallet-connection", () => ({ useWalletConnection: () => ({ connected: mocks.connected, connect: mocks.connect }) }));
vi.mock("../open-position-modal", () => ({ OpenPositionModal: (props: { pair: { poolAddress: string } }) => { mocks.modal(props.pair.poolAddress); return null; } }));

const rhcSpec = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const row = (poolAddress: string, wrapped: string, plain: string, mintA: string, mintB: string, over: Record<string, unknown> = {}) => ({
  poolAddress, mintA, mintB, symbolA: wrapped, symbolB: plain, nameA: `${wrapped} name`, nameB: `${plain} name`, wrappedSymbol: wrapped,
  plainSymbol: plain, feeTierBps: 25, tvlUsd: 1000, volume24hUsd: 100, estimatedFeeAprPct: 5, token2022A: false, token2022B: false, freezeRisk: false, ...over,
});
const rhcSummary = {
  poolId: rhcSpec.poolId, status: "listed", tick: 1, price: null, warnings: [],
  estimatedApr: { tvlUsd: 2000, volume24hUsd: 300, estimatedPoolFeeAprPct: 9 },
  token0: { name: "SpaceX", symbol: "SPCX" }, token1: { name: "SpaceX Ondo", symbol: "SPCXon" },
};
const meteoraRow = row("met1", "NVDAx", "NVDA", "n1", "n2", { protocol: "meteora-dlmm" });

let requested: string[];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  requested = [];
  mocks.apr = { spcxA: 40, spcxB: 12, tsla: 20 };
  mocks.connected = false;
  mocks.connect.mockReset();
  mocks.modal.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(url);
    const body = url.startsWith("/api/rwa-pairs") ? { pairs: [
      row("spcxA", "SPCXx", "SPCX", "x1", "s1"), row("spcxB", "SPCX", "SPCXx", "s1", "x1"), row("tsla", "TSLAx", "TSLA", "t1", "t2", { freezeRisk: true }),
    ] } : url.includes("uniswap-v4-rhc") ? { pools: [rhcSummary] } : url.includes("meteora-dlmm") ? { pairs: [meteoraRow] } : { pairs: [] };
    return { ok: true, json: async () => body };
  }));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const PROD: UnifiedPoolFlags = { orca: false, meteora: false, meteoraOpen: false, rhc: true };
async function render(flags: UnifiedPoolFlags = PROD, props: { deepLinkPool?: string; onOpenRhc?: (r: unknown) => void } = {}) {
  await act(async () => { root.render(createElement(UnifiedPoolsPanel, { flags, onOpenRhc: props.onOpenRhc ?? vi.fn(), deepLinkPool: props.deepLinkPool })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
const shown = () => [...container.querySelectorAll("[data-pool]")].map((el) => el.getAttribute("data-pool"));
const button = (text: string) => [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(text))!;

describe("UnifiedPoolsPanel", () => {
  it("lists Solana and Robinhood Chain pools together, duplicates hidden, highest 7d APR first", async () => {
    await render();
    expect(shown()).toEqual(["solana:spcxA", "solana:tsla", `robinhood:${rhcSpec.poolId.toLowerCase()}`]);
    expect([...container.querySelectorAll("[data-testid=chain-badge]")].map((el) => el.textContent)).toEqual(["Solana", "Solana", "Robinhood Chain"]);
    expect(container.querySelector("[data-testid=hidden-duplicates]")!.textContent).toBe("1 hidden");
    expect(container.textContent).not.toContain("Show all pools");
  });

  it("labels the Robinhood Chain pool 'New chain' with its freeze risk (never 'No flags') and shows <0.01% for a tiny APR", async () => {
    rhcSummary.estimatedApr.estimatedPoolFeeAprPct = 0.000558;
    try {
      await render();
      const card = container.querySelector(`[data-pool="robinhood:${rhcSpec.poolId.toLowerCase()}"]`)!;
      expect([...card.querySelectorAll("[data-risk]")].map((el) => el.textContent)).toEqual(["New chain", "Freeze risk"]);
      expect(card.textContent).not.toContain("No flags");
      expect(card.textContent).toContain("<0.01%");
      expect(card.textContent).not.toContain("0.00%");
      expect(card.querySelector("[data-risk=freeze]")!.getAttribute("title")).toContain("checked on-chain");
    } finally { rhcSummary.estimatedApr.estimatedPoolFeeAprPct = 9; }
  });

  it("shows hidden duplicates only through the Hide duplicate pools toggle", async () => {
    await render();
    const toggle = container.querySelector<HTMLInputElement>("input[role=switch]")!;
    expect(toggle.checked).toBe(true);
    await act(async () => { toggle.click(); });
    expect(shown()).toContain("solana:spcxB");
    expect(container.querySelector("[data-testid=hidden-duplicates]")).toBeNull();
    await act(async () => { toggle.click(); });
    expect(shown()).not.toContain("solana:spcxB");
    expect(container.querySelector("[data-testid=hidden-duplicates]")!.textContent).toBe("1 hidden");
  });

  it("does not ask for or show Orca / Meteora pools when their flags are off", async () => {
    await render();
    expect(requested.some((url) => url.includes("orca") || url.includes("meteora"))).toBe(false);
    await render({ ...PROD, rhc: false });
    expect(shown().some((key) => key?.startsWith("robinhood:"))).toBe(false);
  });

  it("shows Meteora pools with a link to their open flow when the flags are on", async () => {
    await render({ orca: false, meteora: true, meteoraOpen: true, rhc: true });
    expect(shown()).toContain("solana:met1");
    expect(container.querySelector<HTMLAnchorElement>("a[aria-label='Open position in NVDAx/NVDA']")!.getAttribute("href")).toBe("/app/meteora");
  });

  it("switches to a sortable list", async () => {
    await render();
    await act(async () => { button("List").click(); });
    const table = container.querySelector("[data-testid=pools-table]")!;
    expect(table).toBeTruthy();
    expect(table.querySelector("th[aria-sort=descending]")!.textContent).toContain("Est. APR 7d");
    await act(async () => { button("TVL").click(); });
    expect(shown()[0]).toBe(`robinhood:${rhcSpec.poolId.toLowerCase()}`);
    await act(async () => { button("TVL").click(); });
    expect(table.querySelector("th[aria-sort=ascending]")!.textContent).toContain("TVL");
  });

  it("searches by token name and filters by chain and risk", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>("input[type=search]")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, "ondo"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(shown()).toEqual([`robinhood:${rhcSpec.poolId.toLowerCase()}`]);
    await act(async () => { setValue.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); });
    const [chain, , risk] = [...container.querySelectorAll("select")];
    await act(async () => { chain!.value = "solana"; chain!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(shown()).toEqual(["solana:spcxA", "solana:tsla"]);
    await act(async () => { risk!.value = "freeze"; risk!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(shown()).toEqual(["solana:tsla"]);
  });

  it("opening a Solana pool connects the Solana wallet and opens Create position", async () => {
    await render();
    await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-label='Open position in SPCXx/SPCX']")!.click(); });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.modal).toHaveBeenCalledWith("spcxA");
  });

  it("opening the Robinhood Chain pool hands its pool view to the MetaMask flow", async () => {
    const onOpenRhc = vi.fn();
    await render(PROD, { onOpenRhc });
    await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-label='Open position in SPCX/SPCXon']")!.click(); });
    expect(onOpenRhc).toHaveBeenCalledWith({ pool: expect.objectContaining({ poolId: rhcSpec.poolId }) });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("opens the deep-linked pool (/app/rhc redirect)", async () => {
    const onOpenRhc = vi.fn();
    await render(PROD, { onOpenRhc, deepLinkPool: rhcSpec.poolId });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(onOpenRhc).toHaveBeenCalledTimes(1);
  });

  it("explains in plain words when one source fails and still shows the others", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("uniswap-v4-rhc")
      ? { ok: false, status: 502, json: async () => ({ error: "boom" }) }
      : { ok: true, json: async () => ({ pairs: [row("tsla", "TSLAx", "TSLA", "t1", "t2")] }) }));
    await render();
    expect(container.querySelector("[role=alert]")!.textContent).toContain("Robinhood Chain pools could not be loaded right now");
    expect(shown()).toEqual(["solana:tsla"]);
  });
});
