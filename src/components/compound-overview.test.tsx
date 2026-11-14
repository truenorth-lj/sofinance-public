// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CompoundProtocolFee } from "./compound-overview";
import type { CompoundSummary } from "@sofinance/engine/compound-types";

const state = { mintA: "INTCx", mintB: "INTC", decimalsA: 8, decimalsB: 6, fees: { a: "687", b: "4" }, pricing: { priceUsdA: 100, priceUsdB: 100 } } as CompoundSummary["state"];

async function render(summary: CompoundSummary | null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(CompoundProtocolFee, { summary, tokenLabel: (mint: string) => mint })));
  const text = container.textContent;
  await act(async () => root.unmount()); vi.unstubAllGlobals();
  return text;
}

it("states the protocol fee in the compound swap input token before signing", async () => {
  const summary = { state, simulatedHarvest: state.fees, feeBps: 10, feeAmount: "85",
    swaps: [{ inputMint: "INTCx", inputDecimals: 8, feeAmount: "85", feeBps: 10 }] } as unknown as CompoundSummary;
  expect(await render(summary)).toBe("Protocol fee (0.10%): 0.00000085 INTCx");
});

it("shows nothing without a swap fee: no fees-to-compound card, no USDC estimate, no token breakdown", async () => {
  const summary = { state, simulatedHarvest: state.fees, feeBps: 10, feeAmount: "0", swaps: [] } as unknown as CompoundSummary;
  expect(await render(summary)).toBe("");
  expect(await render(null)).toBe("");
});
