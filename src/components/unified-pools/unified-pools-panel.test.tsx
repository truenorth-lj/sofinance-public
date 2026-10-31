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
  state: {} as Record<string, Apr7dState>,
  icons: undefined as undefined | { solana: Record<string, string>; robinhood: Record<string, string> },
  connect: vi.fn(),
  connected: false,
  modal: vi.fn(),
}));
vi.mock("./use-pools-apr7d", () => ({
  usePoolsApr7d: (pools: UnifiedPool[]) => Object.fromEntries(pools.map((pool): [string, Apr7dState] => [pool.key,
    mocks.state[pool.poolAddress] ?? (pool.poolAddress in mocks.apr ? { status: "ready", aprPct: mocks.apr[pool.poolAddress]!, rangeLabel: "Standard", lowConfidence: false, avgDailyVolumeUsd: null } : { status: "missing", reason: "No 7-day estimate" })])),
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
  mocks.state = {};
  mocks.icons = undefined;
  mocks.connect.mockReset();
  mocks.modal.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(url);
    const body = url.startsWith("/api/rwa-pairs") ? { pairs: [
      row("spcxA", "SPCXx", "SPCX", "x1", "s1"), row("spcxB", "SPCX", "SPCXx", "s1", "x1"), row("tsla", "TSLAx", "TSLA", "t1", "t2", { freezeRisk: true }),
    ], ...(mocks.icons ? { tokenIcons: mocks.icons } : {}) } : url.includes("uniswap-v4-rhc") ? { pools: [rhcSummary] } : url.includes("meteora-dlmm") ? { pairs: [meteoraRow] } : { pairs: [] };
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
    expect(container.textContent).toContain("Show all pools (1 hidden)");
  });

  it("shows hidden duplicates after Show all pools and the toggle", async () => {
    await render();
    await act(async () => { container.querySelector<HTMLButtonElement>("[data-testid=show-all-pools]")!.click(); });
    expect(shown()).toContain("solana:spcxB");
    const toggle = container.querySelector<HTMLInputElement>("input[role=switch]")!;
    expect(toggle.checked).toBe(false);
    await act(async () => { toggle.click(); });
    expect(shown()).not.toContain("solana:spcxB");
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

  it("opens the deep-linked Robinhood Chain pool (/app/rhc redirect)", async () => {
    const onOpenRhc = vi.fn();
    await render(PROD, { onOpenRhc, deepLinkPool: rhcSpec.poolId });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(onOpenRhc).toHaveBeenCalledTimes(1);
  });

  it("opens a deep-linked Solana pool's Create position without popping the wallet (old ?pool=&open=1 links)", async () => {
    await render(PROD, { deepLinkPool: "spcxA" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(mocks.modal).toHaveBeenCalledWith("spcxA");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("explains in plain words when one source fails and still shows the others", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("uniswap-v4-rhc")
      ? { ok: false, status: 502, json: async () => ({ error: "boom" }) }
      : { ok: true, json: async () => ({ pairs: [row("tsla", "TSLAx", "TSLA", "t1", "t2")] }) }));
    await render();
    expect(container.querySelector("[role=alert]")!.textContent).toContain("Robinhood Chain pools could not be loaded right now");
    expect(shown()).toEqual(["solana:tsla"]);
  });

  it("shows when the saved pool lists were written (fetchedAt), one UTC time when both chains match", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("uniswap-v4-rhc")
      ? { pools: [rhcSummary], fetchedAt: "2026-10-30T11:02:56.939Z", snapshot: { stale: false } }
      : url.startsWith("/api/rwa-pairs")
        ? { pairs: [row("tsla", "TSLAx", "TSLA", "t1", "t2")], fetchedAt: "2026-10-30T11:02:46.419Z", freshness: { snapshotAt: "2026-10-30T11:02:46.419Z", stale: false } }
        : { pairs: [] } })));
    await render();
    expect(container.querySelector("[data-testid=pools-updated]")!.textContent).toBe("Updated 2026-10-30 11:02 UTC");
  });

  it("names each chain's time when they differ, flags a stale list, and omits the line without times", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("uniswap-v4-rhc")
      ? { pools: [rhcSummary], fetchedAt: "2026-10-29T09:00:00.000Z", snapshot: { stale: true } }
      : { pairs: [row("tsla", "TSLAx", "TSLA", "t1", "t2")], fetchedAt: "2026-10-30T11:02:46.419Z" } })));
    await render();
    expect(container.querySelector("[data-testid=pools-updated]")!.textContent)
      .toBe("Updated 2026-10-30 11:02 UTC (Solana) · 2026-10-29 09:00 UTC (Robinhood Chain) · Data delayed");

    act(() => root.unmount());
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ pairs: [], pools: [] }) })));
    await render();
    expect(container.querySelector("[data-testid=pools-updated]")).toBeNull();
  });
});

describe("UnifiedPoolsPanel cards (the RWA pairs card fields)", () => {
  const card = (key: string) => container.querySelector<HTMLLIElement>(`[data-pool='${key}']`)!;

  it("shows the highest range next to its 7d APR, when the data was updated, and a delayed note", async () => {
    mocks.state = {
      spcxA: { status: "ready", aprPct: 38, rangeLabel: "Tight (±0.05%)", lowConfidence: true, avgDailyVolumeUsd: 100,
        freshness: { snapshotAt: "2026-10-30T00:15:00.000Z", delayed: true } },
      tsla: { status: "missing", reason: "Not enough recent trading data for a 7-day estimate.", degraded: true },
    };
    await render();
    const spcx = card("solana:spcxA");
    expect(spcx.querySelector("[data-testid=apr7d]")!.textContent).toBe("38.00%");
    expect(spcx.querySelector("[data-testid=highest-range]")!.textContent).toBe("Tight (±0.05%)");
    expect(spcx.querySelector("[data-testid=highest-range]")!.textContent).not.toMatch(/%\s*APR|~/);
    expect(spcx.querySelector("[data-testid=apr-freshness]")!.textContent).toMatch(/^Updated .+ · Data delayed$/);
    expect(spcx.querySelector("[data-testid=pool-fee-apr]")!.textContent).toBe("5.00%");
    expect(spcx.querySelector("button[aria-label='About Est. highest range APR']")).not.toBeNull();
    expect(card("solana:tsla").querySelector("[data-testid=highest-range]")!.textContent).toBe("—");
    expect(card("solana:tsla").querySelector("button[aria-label='About Est. highest range APR']")).not.toBeNull();
  });

  it("shows token icons from the database (wrapped first, Raydium fallback), short issuer names, a Plan link and the pool on Raydium", async () => {
    mocks.icons = { solana: { x1: "https://static.jup.ag/x1.png" }, robinhood: {} };
    await render();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(requested.some((url) => url.startsWith("/api/token-metadata"))).toBe(false);
    const spcx = card("solana:spcxA");
    expect([...spcx.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual(["https://static.jup.ag/x1.png", "https://img-v1.raydium.io/icon/s1.png"]);
    expect(spcx.querySelector("h3 + p")!.getAttribute("title")).toBe("SPCXx name / SPCX name");
    expect(spcx.querySelector<HTMLAnchorElement>("a[href^='/app/plan']")!.textContent).toBe("Plan this pool");
    expect(spcx.querySelector<HTMLAnchorElement>("a[href^='/app/plan']")!.getAttribute("href")).toContain("pool=spcxA");
    const raydium = spcx.querySelector<HTMLAnchorElement>("a[target='_blank']")!;
    expect(raydium.getAttribute("href")).toBe("https://raydium.io/clmm/create-position/?pool_id=spcxA");
    expect(raydium.getAttribute("rel")).toBe("noreferrer");
  });

  it("keeps Solana-only fields off the Robinhood Chain card", async () => {
    await render();
    const rhc = card(`robinhood:${rhcSpec.poolId.toLowerCase()}`);
    expect(rhc.querySelector("[data-testid=highest-range]")).toBeNull();
    expect(rhc.querySelector("a[href^='/app/plan']")).toBeNull();
    expect(rhc.textContent).not.toMatch(/Raydium|Phantom/);
  });

  it("shows the Robinhood Chain card's stored icons (no Raydium fallback; letter avatars without one), in the card and list views", async () => {
    const [a, b] = [rhcSpec.currency0.address.toLowerCase(), rhcSpec.currency1.address.toLowerCase()];
    mocks.icons = { solana: {}, robinhood: { [a]: "https://coin-images.coingecko.com/a.png", [b]: "https://coin-images.coingecko.com/b.png" } };
    await render();
    const rhc = card(`robinhood:${rhcSpec.poolId.toLowerCase()}`);
    expect([...rhc.querySelectorAll("img")].map((img) => img.getAttribute("src")).sort())
      .toEqual(["https://coin-images.coingecko.com/a.png", "https://coin-images.coingecko.com/b.png"]);
    mocks.icons = { solana: {}, robinhood: {} };
    act(() => root.unmount()); root = createRoot(container);
    await render();
    const bare = card(`robinhood:${rhcSpec.poolId.toLowerCase()}`);
    expect(bare.querySelector("img")).toBeNull();
    expect(bare.querySelector("[data-testid=pair-token-icons]")!.textContent).toBe("SS"); // first letters of SPCX / SPCXon
    await act(async () => { button("List").click(); });
    // The list view (also the homepage table) shows the same icons / first-letter placeholders.
    const row = container.querySelector(`tr[data-pool="robinhood:${rhcSpec.poolId.toLowerCase()}"]`)!;
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("[data-testid=pair-token-icons]")!.textContent).toBe("SS");
  });

  it("shows a real tiny RHC 24h APR as <0.01% and a missing 7d APR as — on the card (never 0.00%)", async () => {
    rhcSummary.estimatedApr = { tvlUsd: 48795, volume24hUsd: 14.76, estimatedPoolFeeAprPct: 0.0005575645952321763 };
    try {
      await render();
      const rhc = card(`robinhood:${rhcSpec.poolId.toLowerCase()}`);
      expect(rhc.textContent).toContain("<0.01%");
      expect(rhc.textContent).not.toContain("0.00%");
      expect(rhc.querySelector("[data-testid=apr7d]")?.textContent ?? rhc.textContent).toContain("—");
    } finally {
      rhcSummary.estimatedApr = { tvlUsd: 2000, volume24hUsd: 300, estimatedPoolFeeAprPct: 9 };
    }
  });
});
