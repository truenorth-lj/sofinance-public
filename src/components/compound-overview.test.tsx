// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CompoundOverview } from "./compound-overview";
import type { CompoundSummary } from "@/lib/compound-types";

it("shows the combined USDC harvest above token amounts without other sections", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state = { mintA: "INTCx", mintB: "INTC", decimalsA: 8, decimalsB: 6, fees: { a: "687", b: "4" }, pricing: { priceUsdA: 100, priceUsdB: 100 } } as CompoundSummary["state"];
  const summary = { state, simulatedHarvest: state.fees, simulatedDustA: "72", simulatedDustB: "0", feeLamports: 5000, rentLamports: 6156960,
    compoundAccounts: [{ rentLamports: 3078480 }, { rentLamports: 3078480 }], amountMaxA: "687", amountMaxB: "4", swaps: [] } as unknown as CompoundSummary;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(CompoundOverview, { state, summary, tokenLabel: mint => mint, prices: { rate: 150, usdcUsd: 1 } })));
    expect(container.textContent).toContain("0.00000687 INTCx + 0.000004 INTC");
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs[0]?.textContent).toBe("≈ 0.001087 USDC");
    expect(paragraphs[1]?.textContent).toBe("0.00000687 INTCx + 0.000004 INTC");
    expect(container.textContent).not.toContain("Remaining Tokens");
    expect(container.textContent).not.toContain("Estimated Total Cost");
    expect(container.querySelector("details")).toBeNull();
    await act(async () => root.render(createElement(CompoundOverview, { state, summary, tokenLabel: mint => mint, prices: { rate: 150, usdcUsd: null } })));
    expect(container.querySelector("p")?.textContent).toBe("USDC estimate unavailable");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
