// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { UnifiedPool } from "@/lib/unified-pools/model";
import { CARD_POOL_AVG_APR_7D_HELP, CARD_RANGE_APR_7D_HELP } from "@/lib/apr-labels/copy";
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
  registryModal: vi.fn(),
  calc: vi.fn(),
  routeEnabled: true,
  openOverride: null as null | { supported: false; reason: string },
  planOverride: null as null | { supported: false; reason: string },
}));
vi.mock("@/lib/dex/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dex/client")>();
  return { ...actual, dexDescriptors: { ...actual.dexDescriptors, descriptorFor: (id: string) => {
    const descriptor = actual.dexDescriptors.descriptorFor(id);
    if (!descriptor) return descriptor;
    return { ...descriptor, capabilities: { ...descriptor.capabilities,
      ...(mocks.planOverride ? { plan: mocks.planOverride } : {}), ...(mocks.openOverride ? { open: mocks.openOverride } : {}) } };
  } } };
});
vi.mock("./use-pools-apr7d", () => ({
  usePoolsApr7d: (pools: UnifiedPool[]) => Object.fromEntries(pools.map((pool): [string, Apr7dState] => [pool.key,
    mocks.state[pool.poolAddress] ?? (pool.poolAddress in mocks.apr ? { status: "ready", aprPct: mocks.apr[pool.poolAddress]!, rangeLabel: "Standard", lowConfidence: false, capped: false, avgDailyVolumeUsd: null } : { status: "missing", reason: "No 7-day estimate" })])),
}));
vi.mock("../wallet-connection", () => ({ useWalletConnection: () => ({ connected: mocks.connected, connect: mocks.connect }) }));
vi.mock("@/lib/protocol-flags", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/protocol-flags")>(), isDexTxRouteEnabled: () => mocks.routeEnabled }));
vi.mock("./registry-open-modal", () => ({ RegistryOpenModal: (props: { pool: { poolAddress: string }; descriptor: { id: string } }) => {
  mocks.registryModal(props.pool.poolAddress, props.descriptor.id); return null; } }));
vi.mock("./share-calc-dialog", () => ({ ShareCalcDialog: (props: { pool: { poolAddress: string }; open: { kind: string } }) => {
  mocks.calc(props.pool.poolAddress, props.open.kind); return null; } }));
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
  mocks.planOverride = null;
  mocks.openOverride = null;
  mocks.routeEnabled = true;
  mocks.registryModal.mockReset();
  mocks.connect.mockReset();
  mocks.modal.mockReset();
  mocks.calc.mockReset();
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
    expect(container.textContent).toContain("Show duplicates (1)");
  });

  it("card pair names can break after the slash and cut each half, so a long name never runs under the APR at 375 px", async () => {
    await render();
    const name = container.querySelector<HTMLElement>('[data-pool="solana:spcxA"] [data-testid=pool-card-name]')!;
    expect(name.getAttribute("title")).toBe("SPCXx/SPCX");
    expect([...name.children].map((part) => [part.textContent, part.className])).toEqual([
      ["SPCXx/", "inline-block max-w-full truncate align-bottom"], ["SPCX", "inline-block max-w-full truncate align-bottom"]]);
  });

  it("shows hidden duplicates with the Show duplicates pill and hides them again", async () => {
    await render();
    const toggle = () => container.querySelector<HTMLButtonElement>("[data-testid=show-all-pools]")!;
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    await act(async () => { toggle().click(); });
    expect(shown()).toContain("solana:spcxB");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    await act(async () => { toggle().click(); });
    expect(shown()).not.toContain("solana:spcxB");
  });

  it("does not ask for or show Orca / Meteora pools when their flags are off", async () => {
    await render();
    expect(requested.some((url) => url.includes("orca") || url.includes("meteora"))).toBe(false);
    await render({ ...PROD, rhc: false });
    expect(shown().some((key) => key?.startsWith("robinhood:"))).toBe(false);
  });

  it("Meteora pools open the registry dialog from their open capability (no grey button, no Raydium modal, no link out)", async () => {
    await render({ orca: false, meteora: true, meteoraOpen: true, rhc: true });
    expect(shown()).toContain("solana:met1");
    const card = container.querySelector('[data-pool="solana:met1"]')!;
    expect(card.querySelector("[data-testid=open-disabled]")).toBeNull();
    expect(card.querySelectorAll("a")).toHaveLength(0);
    const calculate = card.querySelector<HTMLButtonElement>("button[aria-haspopup=dialog]")!;
    expect(calculate.textContent).toMatch(/^Calculate/);
    await act(async () => { calculate.click(); });
    expect(mocks.calc).toHaveBeenCalledWith("met1", "open");
    const open = card.querySelector<HTMLButtonElement>("button[aria-label^='Open position in']")!;
    await act(async () => { open.click(); });
    expect(mocks.registryModal).toHaveBeenCalledWith("met1", "meteora-dlmm");
    expect(mocks.modal).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledTimes(1); // not connected: the wallet prompt opens with the dialog
  });

  it("an unsupported open capability shows its reason and no button; the dex route off shows no button either", async () => {
    mocks.openOverride = { supported: false, reason: "Opening needs a newer pool version." };
    await render({ orca: false, meteora: true, meteoraOpen: true, rhc: true });
    let card = container.querySelector('[data-pool="solana:met1"]')!;
    expect(card.querySelector("button[aria-label^='Open position in']")).toBeNull();
    expect(card.textContent).toContain("Opening needs a newer pool version.");
    mocks.openOverride = null; mocks.routeEnabled = false;
    await act(async () => root.unmount()); root = createRoot(container);
    await render({ orca: false, meteora: true, meteoraOpen: true, rhc: true });
    card = container.querySelector('[data-pool="solana:met1"]')!;
    expect(card.querySelector("button[aria-label^='Open position in']")).toBeNull();
    expect(card.textContent).toContain("Opening is not available yet");
    expect(mocks.registryModal).not.toHaveBeenCalled();
  });

  it("a deep link to a Meteora pool opens the registry dialog without asking the wallet to connect", async () => {
    await render({ orca: false, meteora: true, meteoraOpen: true, rhc: true }, { deepLinkPool: "met1" });
    await vi.waitFor(() => expect(mocks.registryModal).toHaveBeenCalledWith("met1", "meteora-dlmm"));
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("an unsupported plan capability greys the calculator button with its reason", async () => {
    mocks.planOverride = { supported: false, reason: "Planning needs a paid data feed for this pool." };
    await render({ orca: false, meteora: true, meteoraOpen: true, rhc: true });
    const card = container.querySelector('[data-pool="solana:met1"]')!;
    expect(card.querySelector("button[aria-haspopup=dialog]")).toBeNull();
    const greyed = card.querySelector<HTMLElement>("[data-testid=plan-unavailable]")!;
    expect(greyed.getAttribute("aria-disabled")).toBe("true");
    expect(greyed.getAttribute("title")).toBe("Planning needs a paid data feed for this pool.");
    expect(greyed.textContent).toContain("Planning needs a paid data feed for this pool.");
    // Raydium pools (not in the DEX registry) keep their calculator.
    expect(container.querySelector('[data-pool="solana:spcxA"] button[aria-haspopup=dialog]')).not.toBeNull();
  });

  it("the same pair on Raydium and Meteora is two rows with their protocol badges; duplicates collapse within a protocol", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requested.push(url);
      const body = url.startsWith("/api/rwa-pairs") ? { pairs: [
        row("ray-tsla", "TSLAx", "TSLA", "t1", "t2"),
        row("met-tsla", "TSLA", "TSLAx", "t2", "t1", { protocol: "meteora-dlmm", tvlUsd: 34_000 }),
        row("met-tsla-small", "TSLA", "TSLAx", "t2", "t1", { protocol: "meteora-dlmm", tvlUsd: 2_000 }),
      ] } : { pools: [] };
      return { ok: true, json: async () => body };
    }));
    mocks.apr = { "ray-tsla": 20, "met-tsla": 30, "met-tsla-small": 10 };
    await render({ ...PROD, rhc: false });
    expect(shown()).toEqual(["solana:met-tsla", "solana:ray-tsla"]);
    expect(container.textContent).toContain("Show duplicates (1)");
    const badges = (key: string) => container.querySelector(`[data-pool="${key}"]`)!.textContent;
    expect(badges("solana:met-tsla")).toContain("Meteora");
    expect(badges("solana:ray-tsla")).toContain("Raydium");
    await act(async () => { button("List").click(); });
    expect([...container.querySelectorAll("[data-testid=protocol-badge]")].map((el) => el.textContent)).toEqual(["Meteora", "Raydium"]);
    expect([...container.querySelectorAll("[data-testid=protocol-badge-narrow]")].map((el) => el.textContent)).toEqual(["Meteora", "Raydium"]);
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

  it("searches by token name and filters by chain; there is no risk filter", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>("input[type=search]")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, "ondo"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(shown()).toEqual([`robinhood:${rhcSpec.poolId.toLowerCase()}`]);
    await act(async () => { setValue.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); });
    const selects = [...container.querySelectorAll("select")];
    expect(selects.map((select) => select.closest("label")?.firstChild?.textContent)).not.toContain("Risk");
    expect(container.textContent).not.toMatch(/Any risk|No risk flags/);
    const [chain] = selects;
    await act(async () => { chain!.value = "solana"; chain!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(shown()).toEqual(["solana:spcxA", "solana:tsla"]);
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

  it("shows only the filter bar above the pools: no intro copy, no updated time (11/4 redesign)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("uniswap-v4-rhc")
      ? { pools: [rhcSummary], fetchedAt: "2026-10-30T11:02:56.939Z", snapshot: { stale: false } }
      : { pairs: [row("tsla", "TSLAx", "TSLA", "t1", "t2")], fetchedAt: "2026-10-30T11:02:46.419Z" } })));
    await render();
    expect(container.querySelector("[data-testid=pools-updated]")).toBeNull();
    expect(container.textContent).not.toMatch(/Updated 2026|in one list|Estimates, not guaranteed/);
    expect([...container.querySelectorAll("select")].map((select) => select.options[select.selectedIndex]!.textContent))
      .toEqual(["Chain", "Protocol", "TVL", "Est. APR · 7d"]);
  });
});

describe("UnifiedPoolsPanel TVL filter", () => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const tvlSelect = () => container.querySelector<HTMLSelectElement>("[data-testid=tvl-filter]")!;
  const chooseTvl = async (value: string) => {
    await act(async () => { tvlSelect().value = value; tvlSelect().dispatchEvent(new Event("change", { bubbles: true })); });
  };
  // META's two Solana pools: a tiny pool with a high 7d APR and a bigger one of the same pair.
  const withMeta = () => vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(url);
    const body = url.startsWith("/api/rwa-pairs") ? { pairs: [
      row("metaTiny", "METAx", "META", "m1", "m2", { tvlUsd: 1_023.91 }), row("metaBig", "METAx", "META", "m1", "m2", { tvlUsd: 48_000 }),
      row("tsla", "TSLAx", "TSLA", "t1", "t2", { tvlUsd: 12_000 }),
    ] } : url.includes("uniswap-v4-rhc") ? { pools: [rhcSummary] } : { pairs: [] };
    return { ok: true, json: async () => body };
  }));

  it("offers Any / $5k / $10k / $50k / Custom, defaulting to Any (results unchanged)", async () => {
    await render();
    expect([...tvlSelect().options].map((option) => option.textContent)).toEqual(["TVL", "TVL ≥ $5k", "TVL ≥ $10k", "TVL ≥ $50k", "Custom TVL…"]);
    expect(tvlSelect().value).toBe("any");
    expect(shown()).toEqual(["solana:spcxA", "solana:tsla", `robinhood:${rhcSpec.poolId.toLowerCase()}`]);
  });

  it("filters by TVL before hiding duplicates, so the tiny META pool never hides the big one (cards and list)", async () => {
    mocks.apr = { metaTiny: 673.66, metaBig: 40, tsla: 20 };
    withMeta();
    await render();
    // TVL: Any: the tiny META pool still wins its pair, but ranks after the $5k+ pools (Low TVL).
    expect(shown()).toEqual(["solana:tsla", "solana:metaTiny", `robinhood:${rhcSpec.poolId.toLowerCase()}`]);
    await chooseTvl("5000");
    expect(shown()).toEqual(["solana:metaBig", "solana:tsla"]);
    expect(container.querySelector("[data-testid=show-all-pools]")).toBeNull();
    await act(async () => { button("List").click(); });
    expect(container.querySelector("[data-testid=pools-table]")).toBeTruthy();
    expect(shown()).toEqual(["solana:metaBig", "solana:tsla"]);
    await chooseTvl("50000");
    expect(shown()).toEqual([]);
    expect(container.textContent).toContain("No pools match these filters.");
    await chooseTvl("any");
    expect(shown()).toEqual(["solana:tsla", "solana:metaTiny", `robinhood:${rhcSpec.poolId.toLowerCase()}`]);
  });

  it("takes a custom minimum and works with the search", async () => {
    mocks.apr = { metaTiny: 673.66, metaBig: 40, tsla: 20 };
    withMeta();
    await render();
    await chooseTvl("custom");
    const custom = container.querySelector<HTMLInputElement>("[data-testid=tvl-filter-custom]")!;
    expect(shown()).toHaveLength(3);
    await act(async () => { setValue.call(custom, "20000"); custom.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(shown()).toEqual(["solana:metaBig"]);
    await act(async () => { setValue.call(custom, "1500"); custom.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(shown()).toEqual(["solana:metaBig", "solana:tsla", `robinhood:${rhcSpec.poolId.toLowerCase()}`]);
    const search = container.querySelector<HTMLInputElement>("input[type=search]")!;
    await act(async () => { setValue.call(search, "tsla"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(shown()).toEqual(["solana:tsla"]);
  });
});

describe("UnifiedPoolsPanel cards (the RWA pairs card fields)", () => {
  const card = (key: string) => container.querySelector<HTMLLIElement>(`[data-pool='${key}']`)!;

  it("a new pool (under 7 days of data) shows 'New pool · N days of data', no APR figure, and ranks after every pool with an APR", async () => {
    mocks.apr = { spcxA: 40, tsla: 20 };
    mocks.state = { spcxA: { status: "new", days: 6 } };
    await render();
    expect(shown()[0]).toBe("solana:tsla");
    expect(shown().indexOf("solana:spcxA")).toBeGreaterThan(shown().indexOf("solana:tsla"));
    const amzn = card("solana:spcxA");
    expect(amzn.querySelector("[data-testid=apr7d]")!.textContent).toBe("New pool");
    expect(amzn.querySelector("[data-testid=apr7d-label]")!.textContent).toBe("6 days of data");
    expect(amzn.querySelector("[data-testid=apr7d-new-note]")!.textContent).toContain("7 days of data");
    expect(amzn.querySelector("[data-testid=highest-range]")!.textContent).toBe("—");
    expect(amzn.querySelector("[data-testid=pool-fee-apr]")).toBeNull();
    expect(amzn.textContent).not.toMatch(/\d%/);
    // The list view, sorted by the 7d APR column in either direction, keeps it last too.
    await act(async () => { button("List").click(); });
    const rows = () => [...container.querySelectorAll("[data-testid=pools-table] tbody tr")].map((row) => row.getAttribute("data-pool"));
    const header = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("[data-testid=pools-table] th button")].find((el) => el.textContent?.includes(text))!;
    expect(rows().at(-1)).toBe("solana:spcxA");
    for (const column of ["APR 7d", "APR 7d"]) {
      await act(async () => { header(column).click(); });
      expect(rows().at(-1)).toBe("solana:spcxA");
    }
    const row = container.querySelector("[data-testid=pools-table] tr[data-pool='solana:spcxA']")!;
    expect(row.querySelector("[data-testid=apr7d]")!.textContent).toBe("New pool");
    expect(row.querySelector("[data-testid=apr7d-new-days]")!.textContent).toBe("6 days of data");
    expect(row.querySelector("[data-testid=apr24h]")).toBeNull();
  });

  it("shows the highest range next to its 7d APR, when the data was updated, and a delayed note", async () => {
    mocks.state = {
      spcxA: { status: "ready", aprPct: 38, rangeLabel: "Tight (±0.05%)", lowConfidence: true, capped: false, avgDailyVolumeUsd: 100,
        freshness: { snapshotAt: "2026-10-30T00:15:00.000Z", delayed: true } },
      tsla: { status: "missing", reason: "Not enough recent trading data for a 7-day estimate.", degraded: true },
    };
    await render();
    const spcx = card("solana:spcxA");
    expect(spcx.querySelector("[data-testid=apr7d]")!.textContent).toBe("38.00%");
    expect(spcx.querySelector("[data-testid=highest-range]")!.textContent).toBe("Tight (±0.05%)");
    expect(spcx.querySelector("[data-testid=highest-range]")!.textContent).not.toMatch(/%\s*APR|~/);
    expect(spcx.querySelector("[data-testid=apr-freshness]")!.textContent).toMatch(/^Updated .+ · Data delayed$/);
    // One APR on the card: the 7-day estimate. No 24h pool fee APR field; TVL, 24h vol and fee stay.
    expect(spcx.querySelector("[data-testid=pool-fee-apr]")).toBeNull();
    expect(spcx.textContent).not.toMatch(/APR · 24h/i);
    expect([...spcx.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["TVL", "24h vol", "Fee"]);
    expect(spcx.querySelector("button[aria-label='About Est. highest range APR']")).not.toBeNull();
    expect(card("solana:tsla").querySelector("[data-testid=highest-range]")!.textContent).toBe("—");
    expect(card("solana:tsla").querySelector("button[aria-label='About Est. highest range APR']")).not.toBeNull();
  });

  it("names the range and its $1,000 basis when the pool-fee cap leaves the estimate alone", async () => {
    mocks.state = { tsla: { status: "ready", aprPct: 11.4, rangeLabel: "Tight (±0.05%)", lowConfidence: false, capped: false, avgDailyVolumeUsd: null } };
    await render();
    const spcx = card("solana:tsla");
    expect(spcx.querySelector("[data-testid=apr7d-label]")!.textContent).toBe("Tight-range APR · 7d");
    expect(spcx.querySelector("[data-testid=highest-range]")!.textContent).toBe("Tight (±0.05%)");
    const tip = spcx.querySelector("button[aria-label='About Est. highest range APR']");
    act(() => { (tip as HTMLButtonElement).focus(); });
    expect(spcx.querySelector("[role=tooltip]")!.textContent).toBe(CARD_RANGE_APR_7D_HELP);
  });

  it("says Pool avg APR · 7d with no range when the pool-fee cap lowered the estimate", async () => {
    mocks.state = { tsla: { status: "ready", aprPct: 8.95, rangeLabel: "Micro", lowConfidence: false, capped: true, avgDailyVolumeUsd: null } };
    await render();
    const tsla = card("solana:tsla");
    expect(tsla.querySelector("[data-testid=apr7d]")!.textContent).toBe("8.95%");
    expect(tsla.querySelector("[data-testid=apr7d-label]")!.textContent).toBe("Pool avg APR · 7d");
    expect(tsla.querySelector("[data-testid=highest-range]")).toBeNull();
    expect(tsla.textContent).not.toMatch(/Micro|Highest range/i);
    act(() => { tsla.querySelector<HTMLButtonElement>("button[aria-label='About Pool avg APR']")!.focus(); });
    expect(tsla.querySelector("[role=tooltip]")!.textContent).toBe(CARD_POOL_AVG_APR_7D_HELP);
  });

  it("shows token icons from the database (wrapped first, Raydium fallback), short issuer names, the share calculator and the pool on Raydium", async () => {
    mocks.icons = { solana: { x1: "https://static.jup.ag/x1.png" }, robinhood: {} };
    await render();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(requested.some((url) => url.startsWith("/api/token-metadata"))).toBe(false);
    const spcx = card("solana:spcxA");
    expect([...spcx.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual(["https://static.jup.ag/x1.png", "https://img-v1.raydium.io/icon/s1.png"]);
    expect(spcx.querySelector("h3 + p")!.getAttribute("title")).toBe("SPCXx name / SPCX name");
    const calculate = spcx.querySelector<HTMLButtonElement>("button[aria-haspopup=dialog]")!;
    expect(calculate.textContent).toBe("Calculate shares");
    expect(calculate.getAttribute("aria-label")).toBe("Calculate shares for SPCXx/SPCX");
    // A streak of light circles its border (globals.css `border-beam`, still for reduced motion).
    expect(calculate.className).toContain("border-beam");
    await act(async () => { calculate.click(); });
    expect(mocks.calc).toHaveBeenLastCalledWith("spcxA", "open");
    const raydium = spcx.querySelector<HTMLAnchorElement>("a[target='_blank']")!;
    expect(raydium.getAttribute("href")).toBe("https://raydium.io/clmm/create-position/?pool_id=spcxA");
    expect(raydium.getAttribute("rel")).toBe("noreferrer");
  });

  it("shows no risk badges on any card, even for a pool whose row carries freezeRisk", async () => {
    await render();
    for (const key of ["solana:spcxA", "solana:tsla", `robinhood:${rhcSpec.poolId.toLowerCase()}`]) {
      expect(card(key).textContent).not.toMatch(/Freeze risk|Token-2022|No flags|Pool warning/);
    }
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

  it("shows no 24h APR on an RHC card, even a real tiny one, and a missing 7d APR as — (never 0.00%)", async () => {
    rhcSummary.estimatedApr = { tvlUsd: 48795, volume24hUsd: 14.76, estimatedPoolFeeAprPct: 0.0005575645952321763 };
    try {
      await render();
      const rhc = card(`robinhood:${rhcSpec.poolId.toLowerCase()}`);
      expect(rhc.textContent).not.toContain("<0.01%");
      expect(rhc.querySelector("[data-testid=pool-fee-apr]")).toBeNull();
      expect(rhc.textContent).not.toContain("0.00%");
      expect(rhc.querySelector("[data-testid=apr7d]")?.textContent ?? rhc.textContent).toContain("—");
    } finally {
      rhcSummary.estimatedApr = { tvlUsd: 2000, volume24hUsd: 300, estimatedPoolFeeAprPct: 9 };
    }
  });
});

describe("UnifiedPoolsPanel: Low TVL and Not supported yet (PM 2026-11-04)", () => {
  const NVDA_REASON = "This token uses a balance multiplier, which we don't support yet.";
  beforeEach(() => {
    mocks.apr = { big: 5, googl: 177, skhy: 13, nvda: 300 };
    mocks.state = { intc: { status: "new", days: 5 } };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => (url.startsWith("/api/rwa-pairs") ? { pairs: [
      row("nvda", "NVDAx", "NVDA", "n1", "n2", { tvlUsd: 10_500, unsupported: { issues: ["ScaledUiAmount multiplier not 1"], mints: ["n1"] } }),
      row("intc", "INTCx", "INTC", "i1", "i2", { tvlUsd: 1_884 }),
      row("skhy", "SKHYx", "SKHY", "k1", "k2", { tvlUsd: 126 }),
      row("googl", "GOOGLx", "GOOGL", "g1", "g2", { tvlUsd: 1_932 }),
      row("big", "SPCXx", "SPCX", "x1", "s1", { tvlUsd: 262_029 }),
    ] } : { pairs: [] }) })));
  });
  const flags = { ...PROD, rhc: false };
  const card = (key: string) => container.querySelector(`[data-testid=pools-cards] [data-pool='${key}']`)!;

  it("orders normal, Low TVL, New pool, Not supported yet; tags Low TVL cards; NVDAx shows a disabled Not supported yet", async () => {
    await render(flags);
    expect(shown()).toEqual(["solana:big", "solana:googl", "solana:skhy", "solana:intc", "solana:nvda"]);
    expect(card("solana:googl").querySelector("[data-testid=low-tvl-tag]")!.textContent).toContain("Low TVL");
    expect(card("solana:googl").querySelector("[data-testid=apr7d]")!.textContent).toBe("177.00%");
    expect(card("solana:big").querySelector("[data-testid=low-tvl-tag]")).toBeNull();
    expect(card("solana:intc").querySelector("[data-testid=low-tvl-tag]")).toBeNull(); // a new pool says New pool instead
    const nvda = card("solana:nvda");
    const unsupported = nvda.querySelector("[data-testid=open-unsupported]")!;
    expect(unsupported.textContent).toContain("Not supported yet");
    expect(unsupported.getAttribute("title")).toBe(NVDA_REASON);
    expect(unsupported.getAttribute("aria-disabled")).toBe("true");
    expect(nvda.querySelector("[aria-label^='Open position']")).toBeNull();
    expect(nvda.querySelector("[data-testid=low-tvl-tag]")).toBeNull(); // $10.5k
  });

  it("the list keeps that order by APR in both directions, with the Low TVL tag and Not supported yet in the rows", async () => {
    await render(flags);
    await act(async () => { button("List").click(); });
    const rows = () => [...container.querySelectorAll("[data-testid=pools-table] tbody tr")].map((r) => r.getAttribute("data-pool"));
    const header = () => [...container.querySelectorAll<HTMLButtonElement>("[data-testid=pools-table] th button")].find((el) => el.textContent?.includes("APR 7d"))!;
    expect(rows()).toEqual(["solana:big", "solana:googl", "solana:skhy", "solana:intc", "solana:nvda"]);
    await act(async () => { header().click(); });
    expect(rows()).toEqual(["solana:big", "solana:skhy", "solana:googl", "solana:intc", "solana:nvda"]);
    await act(async () => { header().click(); });
    expect(rows()).toEqual(["solana:big", "solana:googl", "solana:skhy", "solana:intc", "solana:nvda"]);
    const tr = (key: string) => container.querySelector(`[data-testid=pools-table] tr[data-pool='${key}']`)!;
    expect(tr("solana:skhy").querySelector("[data-testid=low-tvl-tag]")).toBeTruthy();
    expect(tr("solana:big").querySelector("[data-testid=low-tvl-tag]")).toBeNull();
    expect(tr("solana:nvda").querySelector("[data-testid=open-unsupported]")!.getAttribute("title")).toBe(NVDA_REASON);
    expect(tr("solana:nvda").querySelector("[aria-label^='Open position']")).toBeNull();
  });

  it("a deep link to the unsupported pool (/app/rwa-pairs?openPool=) does not open Create position", async () => {
    await render(flags, { deepLinkPool: "nvda" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(mocks.modal).not.toHaveBeenCalled();
  });
});
