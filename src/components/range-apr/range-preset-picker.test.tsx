// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_RANGE_UI_PRESETS, type OpenRangePreset } from "@/lib/open-range-presets";
import { degradedPayloadFixture, payloadFixture, payloadWithAprs } from "@/lib/range-apr/payload.fixture";
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

const labels = () => [...container.querySelectorAll("[aria-label='Price range presets'] button")].map((button) => button.querySelector("span")?.textContent);
const readyWith = (aprs: Parameters<typeof payloadWithAprs>[0]): PoolRangeAprState => ({ status: "ready", data: payloadWithAprs(aprs) });

describe("RangePresetPicker", () => {
  it("puts Best leftmost, resolved to the highest-APR candidate, then the rest narrow to wide, then Custom", () => {
    render(readyWith({ micro: 10, tight: 38, standard: 20, wide: 5 }));
    expect(labels()).toEqual(["Best", "Micro", "Standard (±0.3%)", "Wide (±1%)", "Custom"]);
    expect(text("[data-testid='apr-best']")).toBe("~38%");
    expect(text("[data-testid='best-resolved']")).toBe("Tight");
    expect(text("[data-testid='apr-micro']")).toBe("~10%");
    expect(text("[data-testid='apr-standard']")).toBe("~20%");
    expect(text("[data-testid='apr-wide']")).toBe("~5.0%");
    expect(text("[data-testid='apr-custom']")).toBe("—");
    expect(container.querySelector("[data-testid='apr-tight']")).toBeNull();
  });

  it("with the default fixture Best resolves to the narrowest (Micro) and is not duplicated", () => {
    render(ready());
    expect(labels()).toEqual(["Best", "Tight (±0.05%)", "Standard (±0.3%)", "Wide (±1%)", "Custom"]);
    expect(text("[data-testid='best-resolved']")).toBe("Micro");
  });

  it("falls back to the plain row with no Best and no highlight on it while loading, on error and when nothing is priced", () => {
    const plain = ["Micro", "Tight (±0.05%)", "Standard (±0.3%)", "Wide (±1%)", "Custom"];
    for (const state of [
      { status: "loading" } as PoolRangeAprState,
      { status: "error", message: "boom" } as PoolRangeAprState,
      readyWith({ micro: null, tight: null, standard: null, wide: null }),
    ]) {
      render(state);
      expect(labels()).toEqual(plain);
      expect(container.querySelector("[data-testid='preset-best']")).toBeNull();
      expect(container.querySelector("button[aria-label='About Best']")).toBeNull();
      const pressed = [...container.querySelectorAll("[aria-label='Price range presets'] button[aria-pressed='true']")];
      expect(pressed.map((b) => b.querySelector("span")?.textContent)).toEqual(["Standard (±0.3%)"]);
    }
  });

  it("when Standard is the Best pick, Standard is selected by default and shown as Best", () => {
    render(readyWith({ micro: 1, tight: 2, standard: 40, wide: 3 }), { selected: "standard" });
    expect(labels()).toEqual(["Best", "Micro", "Tight (±0.05%)", "Wide (±1%)", "Custom"]);
    const pressed = [...container.querySelectorAll("[aria-label='Price range presets'] button[aria-pressed='true']")];
    expect(pressed.map((b) => b.querySelector("span")?.textContent)).toEqual(["Best"]);
    expect(text("[data-testid='best-resolved']")).toBe("Standard");
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

  it("tells the truth about Best (automatic highest estimated APR, not a model) in the tooltip and the note", () => {
    render(readyWith({ micro: 1, tight: 38, standard: 2, wide: 3 }), { selected: "tight" });
    expect(container.textContent).toMatch(/Best for this pool is Tight: the highest estimated fee APR of the candidate ranges over the last 7 days\. Not a prediction/);
    const info = container.querySelector<HTMLButtonElement>("button[aria-label='About Best']")!;
    vi.spyOn(info, "getBoundingClientRect").mockReturnValue({ left: 10, right: 20, top: 10, bottom: 20, width: 10, height: 10, x: 10, y: 10, toJSON: () => ({}) });
    act(() => { info.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    const tooltip = document.querySelector("[role='tooltip']")!;
    expect(tooltip.textContent).toMatch(/highest estimated fee APR/);
    expect(tooltip.textContent).toMatch(/last 7 days/);
    expect(tooltip.textContent).toMatch(/Not a prediction/);
    expect(tooltip.textContent).toMatch(/risk of leaving range/);
  });

  it("Best selects the resolved candidate's own preset (so quote/prepare use the ordinary path)", () => {
    const { onSelect } = render(readyWith({ micro: 1, tight: 38, standard: 2, wide: 3 }));
    act(() => { container.querySelector<HTMLButtonElement>("[data-testid='preset-best']")!.click(); });
    expect(onSelect).toHaveBeenCalledWith("tight");
  });

  it("selects the other presets on click", () => {
    const { onSelect } = render(ready());
    act(() => { container.querySelector<HTMLButtonElement>("[data-testid='apr-wide']")!.closest("button")!.click(); });
    expect(onSelect).toHaveBeenCalledWith("wide");
  });

  it("highlights Best only while its resolved preset is the selected one", () => {
    render(readyWith({ micro: 1, tight: 38, standard: 2, wide: 3 }), { selected: "tight" });
    const pressed = () => [...container.querySelectorAll("[aria-label='Price range presets'] button[aria-pressed='true']")].map((b) => b.querySelector("span")?.textContent);
    expect(pressed()).toEqual(["Best"]);
    render(readyWith({ micro: 1, tight: 38, standard: 2, wide: 3 }), { selected: "wide" });
    expect(pressed()).toEqual(["Wide (±1%)"]);
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
    render({ status: "ready", data }, { selected: "standard", quotedRange: { tickLower: -9, tickUpper: 9 } });
    expect(text("[data-testid='range-apr-headline']")).toBe(text("[data-testid='apr-wide']"));
  });

  it("shows loading and unavailable states without blocking anything", () => {
    render({ status: "loading" });
    expect(text("[data-testid='apr-micro']")).toBe("…");
    expect(text("[data-testid='range-apr-headline']")).toContain("Estimating…");
    render({ status: "error", message: "boom" });
    expect(text("[data-testid='apr-micro']")).toBe("—");
    expect(container.textContent).toMatch(/Estimate unavailable right now\. Creating a position is not affected/);
    expect(container.textContent).not.toContain("boom");
  });

  it("flags low-confidence samples", () => {
    const data = payloadFixture();
    render({ status: "ready", data: { ...data, sample: { ...data.sample, confidence: "low" } } });
    expect(container.textContent).toMatch(/Low confidence/);
  });

  it("shows no numbers, no Best and an explanation for a degraded payload, with the plain row", () => {
    render({ status: "ready", data: degradedPayloadFixture() });
    expect(labels()).toEqual(["Micro", "Tight (±0.05%)", "Standard (±0.3%)", "Wide (±1%)", "Custom"]);
    expect(container.querySelector("[data-testid='preset-best']")).toBeNull();
    for (const id of ["micro", "tight", "standard", "wide"]) expect(text(`[data-testid='apr-${id}']`)).toBe("—");
    expect(text("[data-testid='range-apr-headline']")).toBe("—");
    expect(container.textContent).toMatch(/Recent price history is temporarily unavailable, so no estimate is shown/);
    expect(container.textContent).not.toMatch(/Best for this pool/);
  });

  it("shows no number for a custom range on a degraded payload", () => {
    render({ status: "ready", data: degradedPayloadFixture() }, {
      selected: "custom", minPrice: String(uiPriceFromTick(-2.5, 6, 6)), maxPrice: String(uiPriceFromTick(2.5, 6, 6)),
    });
    expect(text("[data-testid='apr-custom']")).toBe("—");
    expect(text("[data-testid='range-apr-headline']")).toBe("—");
  });
});
