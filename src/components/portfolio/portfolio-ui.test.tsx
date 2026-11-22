// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceCapabilities } from "@/lib/unified-positions/model";
import { CompoundAllButton, PortfolioSummary } from "./portfolio-summary";
import { PortfolioPositionList, rowActions, type PortfolioRow } from "./portfolio-rows";
import type { UnifiedPosition } from "@/lib/unified-positions/model";

const no = { supported: false as const, reason: "Not available for this pool yet" };
const caps = (over: Partial<SourceCapabilities>): SourceCapabilities => ({
  compound: no, performance: no, deposit: no, withdraw: no, withdrawOutputs: [], exitPreview: no,
  rangeDisplay: "price", manualAdd: false, signer: "solana-wallet", ...over,
});

describe("rowActions: only what the position's DEX supports", () => {
  it("offers Compound, Add and Withdraw in that order when all are supported", () => {
    expect(rowActions(caps({ compound: { supported: true }, deposit: { supported: true }, withdraw: { supported: true, partial: true } }), false))
      .toEqual([{ tool: "compound", label: "Compound" }, { tool: "deposit", label: "Add" }, { tool: "withdraw", label: "Withdraw" }]);
  });
  it("names a full-close-only withdraw Close and never shows an unsupported tool greyed out", () => {
    expect(rowActions(caps({ withdraw: { supported: true, partial: false } }), false)).toEqual([{ tool: "withdraw", label: "Close" }]);
    expect(rowActions(caps({}), false)).toEqual([]);
  });
  it("a closed position offers only Close (when withdraw is supported)", () => {
    const all = caps({ compound: { supported: true }, deposit: { supported: true }, withdraw: { supported: true, partial: true } });
    expect(rowActions(all, true)).toEqual([{ tool: "withdraw", label: "Close" }]);
    expect(rowActions(caps({ compound: { supported: true } }), true)).toEqual([]);
  });
});

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("Compound all (LJ 11/14: greyed out, Coming soon, no transaction)", () => {
  it("a click or tap only shows Coming soon: no request, no wallet", async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    await act(async () => root.render(createElement(CompoundAllButton)));
    const button = container.querySelector<HTMLButtonElement>("[data-testid=compound-all]")!;
    const tip = container.querySelector("[data-testid=compound-all-tip]")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.textContent).toBe("Coming soon");
    expect(tip.classList.contains("hidden")).toBe(true);
    await act(async () => button.click());
    expect(tip.classList.contains("block")).toBe(true);
    await act(async () => button.click());
    expect(tip.classList.contains("hidden")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("PortfolioSummary", () => {
  const totals = { positions: 2, valueUsd: 1234.5, unclaimedFeesUsd: 3.25, cumulativeFeesUsd: 20, pending: 0, missing: 0, cumulativePending: 0 };
  it("shows the three totals, with Compound all in the unclaimed card and under LP value on phones", async () => {
    await act(async () => root.render(createElement(PortfolioSummary, { totals })));
    const text = (id: string) => container.querySelector(`[data-testid=${id}]`)!.textContent!;
    expect(text("portfolio-total-value")).toContain("Total LP value");
    expect(text("portfolio-total-value")).toContain("2 positions · includes unclaimed fees");
    expect(text("portfolio-cumulative-fees")).toContain("Cumulative fees");
    expect(text("portfolio-unclaimed-fees")).toContain("Unclaimed fees");
    expect(container.querySelector("[data-testid=portfolio-unclaimed-fees] [data-testid=compound-all]")).not.toBeNull();
    const phone = container.querySelector("[data-testid=portfolio-total-value] [data-testid=compound-all]")!;
    expect(phone.closest("span")!.className).toContain("sm:hidden");
    expect(container.textContent).not.toMatch(/backtest|earn|yield|auto-rebalance|guarantee/i);
  });
  it("shows the totals so far with a loading hint while positions are read, and says how many could not be read", async () => {
    await act(async () => root.render(createElement(PortfolioSummary, { totals: { ...totals, pending: 1 } })));
    const total = container.querySelector("[data-testid=portfolio-total-value] p")!;
    expect(total.textContent).toBe("$1,234.50");
    expect(total.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("[data-testid=portfolio-loading]")!.textContent).toBe("Loading 1 of 2 positions…");
    await act(async () => root.render(createElement(PortfolioSummary, { totals: { ...totals, valueUsd: null, unclaimedFeesUsd: null, cumulativeFeesUsd: null, pending: 2 } })));
    expect(container.querySelector("[data-testid=portfolio-total-value] p")!.textContent).toBe("—");
    await act(async () => root.render(createElement(PortfolioSummary, { totals })));
    expect(container.querySelector("[data-testid=portfolio-loading]")).toBeNull();
    expect(container.querySelector("[data-testid=portfolio-total-value] p")!.getAttribute("aria-busy")).toBe("false");
    await act(async () => root.render(createElement(PortfolioSummary, { totals: { ...totals, missing: 1 } })));
    expect(container.textContent).toContain("Some values are unavailable for 1 position; totals include available values only.");
  });
});

describe("cumulative fees while history updates", () => {
  const item: UnifiedPosition = {
    key: "raydium-clmm:11111111111111111111111111111111", source: "raydium-clmm", chain: "solana",
    nativeId: "11111111111111111111111111111111", poolId: "p",
    tokenA: { id: "a", symbol: "USDC", decimals: 6 }, tokenB: { id: "b", symbol: "SPCX", decimals: 8 },
    range: { mode: "tick", tickLower: -10, tickUpper: 10, currentTick: 0 }, rangeStatus: "in", liquidity: "1", native: {},
  };
  const list = (row: Partial<PortfolioRow> & { figures: PortfolioRow["figures"]; cumulativeFeesUpdating?: boolean }) =>
    act(async () => root.render(createElement(PortfolioPositionList, {
      groups: [{ chain: "solana", label: "Solana", positions: [item], showSourceName: false }],
      rows: new Map([[item.key, { item, title: "SPCX", subtitle: "", actions: [], ...row }]]),
      disabled: false, popup: null, onOpenDetail: () => undefined, onAction: () => undefined, onClosePopup: () => undefined,
    })));

  it("shows the last complete cumulative fee labeled as updating", async () => {
    await list({ figures: { stock: "SPCX", shares: 1, valueUsd: 100, unclaimedFeesUsd: 0, cumulativeFeesUsd: 11.36 }, cumulativeFeesUpdating: true });
    expect(container.querySelector("[data-testid=position-row-cumulative]")!.textContent).toContain("$11.36");
    expect(container.querySelector("[data-testid=position-row-cumulative]")!.textContent).toContain("Updating");
    expect(container.querySelectorAll("[data-testid=cumulative-fees-updating]").length).toBeGreaterThan(0);
    await act(async () => root.render(createElement(PortfolioSummary, {
      totals: { positions: 1, valueUsd: 100, unclaimedFeesUsd: 0, cumulativeFeesUsd: 11.36, pending: 0, missing: 0, cumulativePending: 0 },
      cumulativeFeesUpdating: true,
    })));
    expect(container.querySelector("[data-testid=portfolio-cumulative-fees]")!.textContent).toContain("$11.36");
    expect(container.querySelector("[data-testid=portfolio-cumulative-fees]")!.textContent).toContain("Updating");
    expect(container.textContent).not.toContain("Some values are unavailable");
  });

  it("shows a dash when a position has never had a complete cumulative fee, and notes that the total excludes it while history is catching up", async () => {
    await list({ figures: { stock: "SPCX", shares: 1, valueUsd: 100, unclaimedFeesUsd: 0, cumulativeFeesUsd: null }, cumulativeFeesUpdating: false });
    expect(container.querySelector("[data-testid=position-row-cumulative]")!.textContent).toBe("—");
    expect(container.querySelector("[data-testid=cumulative-fees-updating]")).toBeNull();
    await act(async () => root.render(createElement(PortfolioSummary, {
      totals: { positions: 1, valueUsd: 100, unclaimedFeesUsd: 0, cumulativeFeesUsd: null, pending: 0, missing: 0, cumulativePending: 1 },
    })));
    expect(container.querySelector("[data-testid=portfolio-cumulative-fees] p")!.textContent).toBe("—");
    expect(container.querySelector("[data-testid=portfolio-cumulative-pending]")!.textContent).toBe("Cumulative fees exclude 1 position.");
    // On the Cumulative fees card, not repeated under Total LP value. Phones hide that card, so the one card keeps the note
    // under its cumulative fees line, phone-only (sm:hidden).
    expect(container.querySelectorAll("[data-testid=portfolio-cumulative-pending]")).toHaveLength(1);
    expect(container.querySelector("[data-testid=portfolio-cumulative-fees] [data-testid=portfolio-cumulative-pending]")).not.toBeNull();
    expect(container.querySelector("[data-testid=portfolio-total-value] [data-testid=portfolio-cumulative-pending]")).toBeNull();
    const phone = container.querySelector("[data-testid=portfolio-total-value] [data-testid=portfolio-cumulative-pending-phone]")!;
    expect(phone.textContent).toBe("Cumulative fees exclude 1 position.");
    expect(phone.className.split(" ")).toContain("sm:hidden");
    expect(container.textContent).not.toContain("Some values are unavailable");
    expect(container.querySelector("[data-testid=cumulative-fees-updating]")).toBeNull();
  });

  it("labels a catching-up dash on the row as updating, like a retained value", async () => {
    await list({ figures: { stock: "SPCX", shares: 1, valueUsd: 100, unclaimedFeesUsd: 0, cumulativeFeesUsd: null }, cumulativeFeesUpdating: true });
    expect(container.querySelector("[data-testid=position-row-cumulative]")!.textContent).toBe("—Updating");
    expect(container.querySelectorAll("[data-testid=cumulative-fees-updating]").length).toBeGreaterThan(0);
  });

  it("hides the exclude note on both layouts while positions are still loading, and shows it once they are in", async () => {
    const totals = { positions: 2, valueUsd: 100, unclaimedFeesUsd: 0, cumulativeFeesUsd: null, pending: 1, missing: 0, cumulativePending: 1 };
    await act(async () => root.render(createElement(PortfolioSummary, { totals })));
    expect(container.querySelector("[data-testid=portfolio-loading]")).not.toBeNull();
    expect(container.querySelector("[data-testid=portfolio-cumulative-pending]")).toBeNull();
    expect(container.querySelector("[data-testid=portfolio-cumulative-pending-phone]")).toBeNull();
    await act(async () => root.render(createElement(PortfolioSummary, { totals: { ...totals, pending: 0 } })));
    expect(container.querySelector("[data-testid=portfolio-cumulative-fees] [data-testid=portfolio-cumulative-pending]")!.textContent).toBe("Cumulative fees exclude 1 position.");
    expect(container.querySelector("[data-testid=portfolio-cumulative-pending-phone]")).not.toBeNull();
  });

  it("still phrases a cumulative-fee null as values unavailable when history is not catching up", async () => {
    await act(async () => root.render(createElement(PortfolioSummary, {
      totals: { positions: 1, valueUsd: 100, unclaimedFeesUsd: 0, cumulativeFeesUsd: null, pending: 0, missing: 1, cumulativePending: 0 },
    })));
    expect(container.textContent).toContain("Some values are unavailable for 1 position; totals include available values only.");
    expect(container.querySelector("[data-testid=portfolio-cumulative-pending]")).toBeNull();
  });
});
