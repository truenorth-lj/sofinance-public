// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PositionPerformanceReport, StockPerformance } from "@/lib/position-performance-report";
import { StockPerformanceTiles } from "./stock-performance-tiles";
import { StocksOverview, type OverviewPosition } from "./stocks-overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nvda: StockPerformance = {
  symbol: "NVDA", priceMint: "NVDAx", priceUsd: 176.35, change24hPct: -6.08, sharesNow: 2.5312, valueUsd: 446.38, sharesIn: 2.5,
  firstDepositAtIso: "2026-10-20T01:00:00.000Z", entryPriceUsd: 187.2, priceChangeUsd: -27.125, priceChangePct: -5.796,
  feeShares: 0.0312, feeUsd: 5.502, totalUsd: -21.623, sparkline24h: [180, 178, 176.35], sparklineSinceEntry: [187.2, 190, 176.35],
  entryPriceSource: "GeckoTerminal daily close, NVDAx / USDC pool", entryUnavailableReason: null,
};
const tsla: StockPerformance = { ...nvda, symbol: "TSLA", priceUsd: 412.1, change24hPct: 1.24, sharesIn: 1.2, sharesNow: 1.2075, valueUsd: 497.61,
  entryPriceUsd: 396.79, priceChangeUsd: 18.37, priceChangePct: 3.86, feeShares: 0.0075, feeUsd: 3.09, totalUsd: 21.46 };
const report = (stock: StockPerformance | null) => ({ stock } as unknown as PositionPerformanceReport);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

describe("StockPerformanceTiles", () => {
  it("shows the stock's 24h move, the shares put in since the deposit day, and the fees as shares and USD", () => {
    act(() => root.render(createElement(StockPerformanceTiles, { stock: nvda, pairLabel: "NVDA / NVDAx" })));
    expect(text("stock-tile-price")).toContain("NVDA price");
    expect(text("stock-tile-price")).toContain("$176.35");
    expect(text("stock-tile-price")).toContain("↓ 6.08%");
    expect(text("stock-tile-shares")).toContain("2.5 shares since Oct 20");
    expect(text("stock-tile-shares")).toContain("−$27.13");
    expect(text("stock-tile-shares")).toContain("from $187.20");
    expect(text("stock-tile-fees")).toContain("$5.50");
    expect(text("stock-tile-fees")).toContain("↑ 0.0312 NVDA");
    expect(text("stock-tile-fees")).not.toContain("at $");
    expect(text("stock-total")).toContain("−$21.62");
    expect(container.querySelectorAll('[data-testid="stock-sparkline"]')).toHaveLength(2);
    expect(text("stock-footnote")).toContain("USD at current prices");
    expect(text("stock-footnote")).not.toContain("CoinGecko");
  });

  it("keeps every tile label on one line", () => {
    act(() => root.render(createElement(StockPerformanceTiles, { stock: nvda })));
    for (const tile of container.querySelectorAll('[data-testid^="stock-tile-"]')) {
      expect(tile.firstElementChild!.className).toContain("whitespace-nowrap");
      expect(tile.firstElementChild!.className).toContain("truncate");
    }
  });

  it("says why the price change is missing instead of showing zero", () => {
    act(() => root.render(createElement(StockPerformanceTiles, { stock: { ...nvda, entryPriceUsd: null, priceChangeUsd: null, priceChangePct: null,
      totalUsd: null, entryUnavailableReason: "Past prices for this stock are unavailable right now." } })));
    expect(text("stock-tile-shares")).toContain("—");
    const note = container.querySelector('[data-testid="stock-tile-shares"] [aria-describedby]')!;
    expect(note).not.toBeNull();
    expect(note.textContent).toBe("Entry price unavailable");
    const reason = document.getElementById(note.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toBe("Past prices for this stock are unavailable right now.");
    expect(reason?.classList.contains("sr-only")).toBe(true);
    expect(note.hasAttribute("title")).toBe(false);
    expect(note.hasAttribute("aria-label")).toBe(false);
    expect(text("stock-total")).toContain("Entry price unavailable");
    expect(text("stock-total")).toContain("—");
  });
});

describe("missing price explanations", () => {
  it.each([
    [null, "Entry price unavailable", "Entry price is unavailable for this position."],
    [187.2, "Price change unavailable", "Price change since deposit is unavailable for this position."],
  ] as const)("provides a full fallback reason when entry price is %s and reason is null", (entryPriceUsd, label, fallback) => {
    act(() => root.render(createElement(StockPerformanceTiles, { stock: { ...nvda, entryPriceUsd,
      priceChangeUsd: null, priceChangePct: null, totalUsd: null, entryUnavailableReason: null } })));
    const note = container.querySelector('[data-testid="stock-tile-shares"] [aria-describedby]')!;
    expect(note.textContent).toBe(label);
    const reason = document.getElementById(note.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toBe(fallback);
    expect(reason?.classList.contains("sr-only")).toBe(true);
  });
});

const drilldownPosition = (key: string, poolId: string, stock = nvda, source = "Raydium"): OverviewPosition => ({
  key, positionId: `position-${key}-full-id`, pool: { id: poolId, label: "NVDA / NVDAx", source },
  load: async () => { throw new Error("Must reuse the loaded report"); },
  fromPanel: { report: { ...report(stock), poolId }, error: false },
});
const expandStock = async (symbol = "NVDA") => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="stock-row"] > button')]
    .find((item) => item.textContent?.startsWith(symbol))!;
  await act(async () => button.click());
  return document.getElementById(button.getAttribute("aria-controls")!)!;
};

describe("StocksOverview", () => {
  it("embeds a single stock drilldown without a second All positions heading", async () => {
    const selected: string[] = [];
    await act(async () => root.render(createElement(StocksOverview, {
      embedded: true, positions: [drilldownPosition("embedded-solo", "solo-pool")],
      onSelectPosition: (key: string) => selected.push(key),
    })));
    expect(container.querySelector('[data-testid="stocks-overview"]')).not.toBeNull();
    expect(container.textContent).not.toContain("All positions");
    const expanded = await expandStock();
    await act(async () => expanded.querySelector<HTMLButtonElement>('[data-testid="stock-position-select"]')!.click());
    expect(selected).toEqual(["embedded-solo"]);
  });
  it("keeps embedded fallback reachable for loading, failed, null and non-stock reports, covering only stock drilldowns", async () => {
    const positions: OverviewPosition[] = [
      { key: "waiting", load: async () => null, fromPanel: "loading" },
      { key: "failed", load: async () => null, fromPanel: { report: null, error: true } },
      { key: "null", load: async () => null, fromPanel: { report: null, error: false } },
      { key: "nonstock", load: async () => report(null), fromPanel: { report: report(null), error: false } },
    ];
    const renderRemainingPositions = (covered: ReadonlySet<string>) => createElement("div", { "data-testid": "remaining" }, positions.filter((p) => !covered.has(p.key)).map((p) => p.key).join(","));
    await act(async () => root.render(createElement(StocksOverview, { embedded: true, positions, renderRemainingPositions })));
    expect(text("remaining")).toBe("waiting,failed,null,nonstock");
    positions[0] = { ...positions[0]!, fromPanel: { report: null, error: true } };
    await act(async () => root.render(createElement(StocksOverview, { embedded: true, positions, renderRemainingPositions })));
    expect(text("remaining")).toBe("waiting,failed,null,nonstock");
    expect(container.textContent).toContain("2 positions could not be read");
    positions[0] = { ...positions[0]!, fromPanel: { report: report(nvda), error: false } };
    await act(async () => root.render(createElement(StocksOverview, { embedded: true, positions, renderRemainingPositions })));
    expect(text("remaining")).toBe("failed,null,nonstock");
    expect(container.querySelectorAll('[data-testid="stock-row"]')).toHaveLength(1);
  });

  it("shows only fallback rows, not a zero-valued stock portfolio, when no stock reports exist", async () => {
    await act(async () => root.render(createElement(StocksOverview, {
      embedded: true, positions: [{ key: "nonstock-only", load: async () => report(null) }],
      renderRemainingPositions: () => createElement("button", null, "Select nonstock-only"),
    })));
    expect(container.textContent).toContain("Select nonstock-only");
    expect(container.querySelector('[data-testid="overview-tile-fees"]')).toBeNull();
    expect(container.textContent).not.toContain("Portfolio value");
    expect(container.querySelector('[data-testid="stock-footnote"]')).toBeNull();
  });

  it("drills into two pools for one stock without duplicating stock aggregates", async () => {
    const positions = [drilldownPosition("pool-a-position", "pool-aaaaaaaaaaaa"),
      drilldownPosition("pool-b-position", "pool-bbbbbbbbbbbb", { ...nvda, valueUsd: 100, feeUsd: 2 }, "Orca")];
    await act(async () => root.render(createElement(StocksOverview, { positions })));
    const expanded = await expandStock();
    const groups = expanded.querySelectorAll('[data-testid="stock-pool-group"]');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain("Raydium");
    expect(groups[1]!.textContent).toContain("Orca");
    for (const group of groups) expect(group.textContent).toContain("NVDA / NVDAx");
    expect(groups[0]!.querySelector('[title="pool-aaaaaaaaaaaa"]')?.textContent).toBe("pool…aaaa");
    const positionRows = expanded.querySelectorAll('[data-testid="stock-position"]');
    expect(positionRows).toHaveLength(2);
    expect(positionRows[0]!.querySelector('[title="position-pool-a-position-full-id"]')?.textContent).toBe("posi…l-id");
    expect(positionRows[0]!.textContent).toContain("Value $446.38");
    expect(positionRows[0]!.textContent).toContain("Fees $5.50");
    expect(positionRows[1]!.textContent).toContain("Value $100.00");
    expect(positionRows[1]!.textContent).toContain("Fees $2.00");
    expect(expanded.querySelectorAll('[data-testid="stock-performance"]')).toHaveLength(1);
    expect(expanded.querySelectorAll('[data-testid="stock-total"]')).toHaveLength(1);
    expect(text("overview-tile-fees")).toContain("$7.50");
    expect(text("stocks-overview")).toContain("Portfolio value$546.38");
    expect(expanded.querySelector('[data-testid="stock-tile-fees"]')?.textContent).toContain("$7.50");
    expect(expanded.querySelectorAll('[data-testid="stock-position"] button, button[data-testid="stock-position"], a')).toHaveLength(0);
  });

  it("keeps same-pool positions distinct and selects their exact keys with controlled pressed state", async () => {
    const positions = [drilldownPosition("source:first:exact-key", "shared-pool"),
      drilldownPosition("source:second:exact-key", "shared-pool", { ...nvda, valueUsd: 80, feeUsd: 1 })];
    const selected: string[] = [];
    const onSelectPosition = (key: string) => selected.push(key);
    await act(async () => root.render(createElement(StocksOverview, {
      positions, selectedPositionKey: positions[0]!.key, onSelectPosition,
    })));
    const expanded = await expandStock();
    expect(expanded.querySelectorAll('[data-testid="stock-pool-group"]')).toHaveLength(1);
    const buttons = expanded.querySelectorAll<HTMLButtonElement>('[data-testid="stock-position"] button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0]!.textContent).toContain("Selected");
    expect(buttons[1]!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => buttons[1]!.click());
    expect(selected).toEqual(["source:second:exact-key"]);
    await act(async () => root.render(createElement(StocksOverview, {
      positions, selectedPositionKey: positions[1]!.key, onSelectPosition,
    })));
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(text("overview-tile-fees")).toContain("$6.50");
    expect(text("stocks-overview")).toContain("Portfolio value$526.38");
  });

  it("disables position selection while leaving stock expansion usable", async () => {
    const positions = [drilldownPosition("disabled-a", "pool-a"), drilldownPosition("disabled-b", "pool-b")];
    const selected: string[] = [];
    const onSelectPosition = (key: string) => selected.push(key);
    await act(async () => root.render(createElement(StocksOverview, {
      positions, onSelectPosition, selectedPositionKey: "disabled-a", selectionDisabled: true,
    })));
    const expanded = await expandStock();
    const buttons = expanded.querySelectorAll<HTMLButtonElement>('[data-testid="stock-position"] button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.getAttribute("data-testid")).toBe("stock-position-select");
    expect(buttons[0]!.getAttribute("data-position-key")).toBe("disabled-a");
    expect(buttons[1]!.getAttribute("data-position-key")).toBe("disabled-b");
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
    }
    expect(selected).toEqual([]);
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => root.render(createElement(StocksOverview, {
      positions, onSelectPosition, selectionDisabled: false,
    })));
    expect(buttons[1]!.disabled).toBe(false);
    await act(async () => buttons[1]!.click());
    expect(selected).toEqual(["disabled-b"]);
  });

  it("does not group identical pool IDs across different protocols", async () => {
    const positions = [drilldownPosition("raydium-position", "same-pool-id"),
      drilldownPosition("orca-position", "same-pool-id", nvda, "Orca")];
    await act(async () => root.render(createElement(StocksOverview, { positions })));
    const expanded = await expandStock();
    expect(expanded.querySelectorAll('[data-testid="stock-pool-group"]')).toHaveLength(2);
    for (const group of expanded.querySelectorAll('[data-testid="stock-pool-group"]')) {
      expect(group.querySelectorAll('[data-testid="stock-position"]')).toHaveLength(1);
    }
  });

  it("falls back to loaded report IDs or keys for metadata-less read-only positions", async () => {
    const positions: OverviewPosition[] = [
      { key: "legacy-a", load: async () => ({ ...report(nvda), poolId: "legacy-pool", positionMint: "legacy-position" }) },
      { key: "legacy-b", load: async () => ({ ...report(nvda), poolId: "legacy-pool" }) },
      { key: "legacy-c", load: async () => report({ ...nvda, valueUsd: null, feeUsd: null }) },
    ];
    await act(async () => root.render(createElement(StocksOverview, { positions })));
    const expanded = await expandStock();
    const groups = expanded.querySelectorAll('[data-testid="stock-pool-group"]');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.querySelectorAll('[data-testid="stock-position"]')).toHaveLength(2);
    expect(groups[0]!.querySelector('[title="legacy-pool"]')).not.toBeNull();
    expect(groups[0]!.querySelector('[title="legacy-position"]')).not.toBeNull();
    expect(groups[0]!.querySelector('[title="legacy-b"]')).not.toBeNull();
    expect(groups[1]!.querySelector('[title="legacy-c"]')).not.toBeNull();
    expect(groups[1]!.textContent).toContain("Value —");
    expect(groups[1]!.textContent).toContain("Fees —");
    expect(expanded.querySelectorAll("button, a")).toHaveLength(0);
  });

  it("includes a selectable position for a stock held in only one position", async () => {
    const positions = [drilldownPosition("only-nvda", "nvda-pool"), drilldownPosition("only-tsla", "tsla-pool", tsla)];
    const selected: string[] = [];
    await act(async () => root.render(createElement(StocksOverview, {
      positions, onSelectPosition: (key: string) => selected.push(key),
    })));
    const expanded = await expandStock("TSLA");
    const buttons = expanded.querySelectorAll<HTMLButtonElement>('[data-testid="stock-position-select"]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("data-position-key")).toBe("only-tsla");
    await act(async () => buttons[0]!.click());
    expect(selected).toEqual(["only-tsla"]);
    expect(expanded.textContent).not.toContain("position-only-nvda");
  });

  it("adds up every stock once all positions are read, one row per stock", async () => {
    let releaseSecond!: () => void;
    const positions: OverviewPosition[] = [
      { key: "p1", load: async () => report(nvda) },
      { key: "p2", load: () => new Promise((resolve) => { releaseSecond = () => resolve(report(tsla)); }) },
      { key: "p3", load: async () => report(null) },
    ];
    await act(async () => root.render(createElement(StocksOverview, { positions })));
    expect(container.textContent).toContain("Loading 1 of 3 positions");
    expect(text("overview-tile-fees")).toContain("—");
    expect(container.querySelectorAll('[data-testid="stock-row"]')).toHaveLength(1);

    await act(async () => releaseSecond());
    expect(container.querySelectorAll('[data-testid="stock-row"]')).toHaveLength(2);
    expect(text("overview-tile-fees")).toContain("$8.59");
    expect(text("overview-tile-fees")).toContain("across 2 stocks");
    expect(text("overview-tile-price")).toContain("−$8.75");
    expect(text("stocks-overview")).toContain("$943.99");

    const button = container.querySelector('[data-testid="stock-row"] button') as HTMLButtonElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const expanded = document.getElementById(button.getAttribute("aria-controls")!)!;
    const tiles = expanded.querySelector('[data-testid="stock-performance"]')!;
    expect(tiles.parentElement?.classList.contains("pt-3")).toBe(true);
    expect(tiles.querySelector(".grid")?.classList.contains("gap-3")).toBe(true);
  });

  it("shows nothing for a single position", async () => {
    await act(async () => root.render(createElement(StocksOverview, { positions: [{ key: "solo", load: async () => report(nvda) }] })));
    expect(container.querySelector('[data-testid="stocks-overview"]')).toBeNull();
  });
});
