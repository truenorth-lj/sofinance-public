// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceCapabilities } from "@/lib/unified-positions/model";
import { CompoundAllButton, PortfolioSummary } from "./portfolio-summary";
import { rowActions } from "./portfolio-rows";

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
  const totals = { positions: 2, valueUsd: 1234.5, unclaimedFeesUsd: 3.25, cumulativeFeesUsd: 20, pending: 0, missing: 0 };
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
  it("shows dashes while positions are read, and says how many could not be read", async () => {
    await act(async () => root.render(createElement(PortfolioSummary, { totals: { ...totals, pending: 1 } })));
    expect(container.querySelector("[data-testid=portfolio-total-value] p")!.textContent).toBe("—");
    expect(container.textContent).toContain("Reading 1 of 2…");
    await act(async () => root.render(createElement(PortfolioSummary, { totals: { ...totals, missing: 1 } })));
    expect(container.textContent).toContain("1 position could not be read and is not included.");
  });
});
