// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_RANGE_UI_PRESETS, type OpenRangePreset } from "@/lib/open-range-presets";
import { payloadFixture } from "@/lib/range-apr/payload.fixture";
import { uiPriceFromTick } from "@/lib/range-apr/tick-math";
import { RangePresetPicker } from "./range-preset-picker";
import type { PoolRangeAprState } from "./use-pool-range-apr";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Props = Partial<Parameters<typeof RangePresetPicker>[0]>;
function render(apr: PoolRangeAprState, props: Props = {}) {
  const onSelect = vi.fn<(preset: OpenRangePreset) => void>();
  act(() => root.render(createElement(RangePresetPicker, {
    presets: OPEN_RANGE_UI_PRESETS, selected: "standard", onSelect, minPrice: "", maxPrice: "",
    onMinPrice: vi.fn(), onMaxPrice: vi.fn(), apr, quotedRange: null, ...props,
  })));
  return { onSelect };
}
const text = (selector: string) => container.querySelector(selector)?.textContent ?? null;
const ready = (): PoolRangeAprState => ({ status: "ready", data: payloadFixture() });

describe("RangePresetPicker", () => {
  it("puts AI pick left of Tight and shows an APR under every preset button", () => {
    render(ready());
    const labels = [...container.querySelectorAll("[aria-label='Price range presets'] button")].map((button) => button.querySelector("span")?.textContent);
    expect(labels).toEqual(["AI pick", "Tight (±0.05%)", "Standard (±0.3%)", "Wide (±1%)", "Custom"]);
    const ai = text("[data-testid='apr-ai']");
    const tight = text("[data-testid='apr-tight']");
    const wide = text("[data-testid='apr-wide']");
    expect(ai).toMatch(/^~\d/);
    expect(tight).toMatch(/^~\d/);
    expect(wide).toMatch(/^~\d/);
    expect(Number.parseFloat(ai!.slice(1))).toBeGreaterThan(Number.parseFloat(wide!.slice(1)));
    expect(text("[data-testid='apr-custom']")).toBe("—");
  });

  it("headlines the selected preset's estimate with its in-range share and the estimate caveat", () => {
    const data = payloadFixture();
    render({ status: "ready", data }, { selected: "tight" });
    const tight = data.presets.find((preset) => preset.id === "tight")!.estimate;
    expect(tight.status).toBe("ok");
    expect(text("[data-testid='range-apr-headline']")).toBe(text("[data-testid='apr-tight']"));
    expect(container.textContent).toContain("Est. fee APR");
    expect(container.textContent).toMatch(/of recent volume traded inside this range/);
    expect(container.textContent).toContain("~$100 deposit");
  });

  it("tells the truth about the AI pick (fixed rule, not a model) in the visible note and the tooltip", () => {
    render(ready(), { selected: "ai" });
    expect(container.textContent).toMatch(/AI pick is a fixed rule \(centred ±2 tick-spacing steps\), not an AI model/);
    const info = container.querySelector<HTMLButtonElement>("button[aria-label='About AI pick']")!;
    vi.spyOn(info, "getBoundingClientRect").mockReturnValue({ left: 10, right: 20, top: 10, bottom: 20, width: 10, height: 10, x: 10, y: 10, toJSON: () => ({}) });
    act(() => { info.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    const tooltip = document.querySelector("[role='tooltip']")!;
    expect(tooltip.textContent).toMatch(/fixed rule, not an AI model/);
    expect(tooltip.textContent).toMatch(/2 tick-spacing steps below and 2 above/);
  });

  it("selects presets on click", () => {
    const { onSelect } = render(ready());
    act(() => { container.querySelector<HTMLButtonElement>("[data-testid='apr-ai']")!.closest("button")!.click(); });
    expect(onSelect).toHaveBeenCalledWith("ai");
  });

  it("marks only the selected preset as pressed", () => {
    render(ready(), { selected: "ai" });
    const pressed = [...container.querySelectorAll("[aria-label='Price range presets'] button[aria-pressed='true']")].map((b) => b.querySelector("span")?.textContent);
    expect(pressed).toEqual(["AI pick"]);
  });

  it("estimates a custom range live from the typed prices", () => {
    const min = String(uiPriceFromTick(-2.5, 6, 6));
    const max = String(uiPriceFromTick(2.5, 6, 6));
    render(ready(), { selected: "custom", minPrice: min, maxPrice: max });
    expect(text("[data-testid='apr-custom']")).toMatch(/^~\d/);
    expect(text("[data-testid='range-apr-headline']")).toBe(text("[data-testid='apr-custom']"));
    expect(container.querySelector("input[aria-label='Minimum price']")).not.toBeNull();
  });

  it("prompts for a complete custom range and explains an invalid one", () => {
    render(ready(), { selected: "custom" });
    expect(container.textContent).toMatch(/Enter a min and max price/);
    render(ready(), { selected: "custom", minPrice: "1.2", maxPrice: "0.8" });
    expect(container.textContent).toMatch(/Enter a valid price range/);
    render(ready(), { selected: "custom", minPrice: "0.5", maxPrice: "2" });
    expect(container.textContent).toMatch(/beyond the analysed price window/);
  });

  it("prices the live quote's aligned ticks when present", () => {
    const data = payloadFixture();
    render({ status: "ready", data }, { selected: "ai", quotedRange: { tickLower: -9, tickUpper: 9 } });
    expect(text("[data-testid='range-apr-headline']")).toBe(text("[data-testid='apr-wide']"));
  });

  it("shows loading and unavailable states without blocking anything", () => {
    render({ status: "loading" });
    expect(text("[data-testid='apr-ai']")).toBe("…");
    expect(text("[data-testid='range-apr-headline']")).toContain("Estimating…");
    render({ status: "error", message: "boom" });
    expect(text("[data-testid='apr-ai']")).toBe("—");
    expect(container.textContent).toMatch(/Estimate unavailable right now\. Creating a position is not affected/);
    expect(container.textContent).not.toContain("boom");
  });

  it("flags low-confidence samples", () => {
    const data = payloadFixture();
    render({ status: "ready", data: { ...data, sample: { ...data.sample, confidence: "low" } } });
    expect(container.textContent).toMatch(/Low confidence/);
  });
});
