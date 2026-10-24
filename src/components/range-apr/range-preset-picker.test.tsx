// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_RANGE_UI_PRESETS, type OpenRangePreset } from "@sofinance/engine/open-range-presets";
import { LOWER_AMOUNT_TO_OPEN } from "@/lib/range-apr/copy";
import { formatEstimate } from "@/lib/range-apr/format";
import { degradedPayloadFixture, payloadFixture, payloadWithAprs } from "@/lib/range-apr/payload.fixture";
import { payloadForCapital } from "@/lib/range-apr/size-aware";
import { uiPriceFromTick } from "@sofinance/engine/range-apr/tick-math";
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

const buttons = () => [...container.querySelectorAll("[aria-label='Price range presets'] button")];
const labels = () => buttons().map((button) => button.querySelector("span")?.textContent);
const readyWith = (aprs: Parameters<typeof payloadWithAprs>[0]): PoolRangeAprState => ({ status: "ready", data: payloadWithAprs(aprs) });

describe("RangePresetPicker", () => {
  it("puts Best first, resolved to the highest-APR candidate, then the rest narrow to wide, then Custom", () => {
    render(readyWith({ micro: 10, tight: 38, standard: 20, wide: 5 }));
    expect(labels()).toEqual(["Best", "Micro", "Standard", "Wide", "Custom"]);
    expect(text("[data-testid='best-resolved']")).toBe("Tight");
    expect(buttons().slice(1).map((button) => button.querySelectorAll("span")[1]?.textContent))
      .toEqual(["±0.02%", "±0.3%", "±1%", "Min–max"]);
  });

  it("shows Micro's width as a percent of this pool's price, and in steps only until the pool is known", () => {
    render(ready());
    expect(text("[data-testid='preset-best']")).toBe("BestMicro±0.02%");
    render({ status: "ready", data: { ...payloadFixture(), pool: { ...payloadFixture().pool, tickSpacing: 10 } } });
    expect(text("[data-testid='preset-best']")).toBe("BestMicro±0.2%");
    render({ status: "loading" });
    expect(text("[data-testid='preset-micro']")).toBe("Micro±2 steps");
  });

  it("marks Best with the brand mark and a glow behind it", () => {
    render(readyWith({ micro: 10, tight: 38, standard: 20, wide: 5 }));
    const best = container.querySelector("[data-testid='preset-best']")!;
    expect(best.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 64 64");
    expect(best.textContent).toBe("BestTight±0.05%");
    expect(best.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
    expect(best.previousElementSibling?.className).toContain("animate-halo");
  });

  it("keeps the estimates in the APR card: the selection as the headline, the other ranges under it, none on the buttons", () => {
    render(readyWith({ micro: 10, tight: 38, standard: 20, wide: 5 }));
    for (const button of buttons()) expect(button.textContent).not.toContain("~");
    expect(text("[data-testid='range-apr-headline']")).toBe("~20%");
    expect(text("[data-testid='apr-tight']")).toBe("~38%");
    expect(text("[data-testid='apr-micro']")).toBe("~10%");
    expect(text("[data-testid='apr-wide']")).toBe("~5.0%");
    expect(container.querySelector("[data-testid='apr-standard']")).toBeNull();
    expect(container.querySelector("[data-testid='range-apr-headline']")!.parentElement!.textContent).toContain("Other ranges");
  });

  it("with the default fixture Best resolves to the narrowest (Micro) and is not duplicated", () => {
    render(ready());
    expect(labels()).toEqual(["Best", "Tight", "Standard", "Wide", "Custom"]);
    expect(text("[data-testid='best-resolved']")).toBe("Micro");
  });

  it("falls back to the plain row with no Best and no highlight on it while loading, on error and when nothing is priced", () => {
    const plain = ["Micro", "Tight", "Standard", "Wide", "Custom"];
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
      expect(pressed.map((b) => b.querySelector("span")?.textContent)).toEqual(["Standard"]);
    }
  });

  it("when Standard is the Best pick, Standard is selected by default and shown as Best", () => {
    render(readyWith({ micro: 1, tight: 2, standard: 40, wide: 3 }), { selected: "standard" });
    expect(labels()).toEqual(["Best", "Micro", "Tight", "Wide", "Custom"]);
    const pressed = [...container.querySelectorAll("[aria-label='Price range presets'] button[aria-pressed='true']")];
    expect(pressed.map((b) => b.querySelector("span")?.textContent)).toEqual(["Best"]);
    expect(text("[data-testid='best-resolved']")).toBe("Standard");
  });

  it("headlines the selected preset's estimate with its in-range share and the estimate caveat", () => {
    const data = payloadFixture();
    render({ status: "ready", data }, { selected: "tight" });
    const tight = data.presets.find((preset) => preset.id === "tight")!.estimate;
    expect(tight.status).toBe("ok");
    expect(text("[data-testid='range-apr-headline']")).toBe(formatEstimate(tight));
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
    act(() => { container.querySelector<HTMLButtonElement>("[data-testid='preset-wide']")!.click(); });
    expect(onSelect).toHaveBeenCalledWith("wide");
  });

  it("highlights Best only while its resolved preset is the selected one", () => {
    render(readyWith({ micro: 1, tight: 38, standard: 2, wide: 3 }), { selected: "tight" });
    const pressed = () => [...container.querySelectorAll("[aria-label='Price range presets'] button[aria-pressed='true']")].map((b) => b.querySelector("span")?.textContent);
    expect(pressed()).toEqual(["Best"]);
    render(readyWith({ micro: 1, tight: 38, standard: 2, wide: 3 }), { selected: "wide" });
    expect(pressed()).toEqual(["Wide"]);
  });

  it("estimates a custom range live from the typed prices", () => {
    const min = String(uiPriceFromTick(-2.5, 6, 6));
    const max = String(uiPriceFromTick(2.5, 6, 6));
    render(ready(), { selected: "custom", minPrice: min, maxPrice: max });
    expect(text("[data-testid='range-apr-headline']")).toMatch(/^~\d/);
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
    expect(container.textContent).toContain("Finding the best range…");
    expect(text("[data-testid='range-apr-headline']")).toContain("Estimating…");
    expect(container.textContent).not.toContain("Other ranges");
    render({ status: "error", message: "boom" });
    expect(container.textContent).not.toContain("Finding the best range…");
    expect(text("[data-testid='range-apr-headline']")).toBe("—");
    expect(container.textContent).not.toContain("Other ranges");
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
    expect(labels()).toEqual(["Micro", "Tight", "Standard", "Wide", "Custom"]);
    expect(container.querySelector("[data-testid='preset-best']")).toBeNull();
    for (const id of ["micro", "tight", "standard", "wide"]) expect(container.querySelector(`[data-testid='apr-${id}']`)).toBeNull();
    expect(text("[data-testid='range-apr-headline']")).toBe("—");
    expect(container.textContent).toMatch(/Recent price history is temporarily unavailable, so no estimate is shown/);
    expect(container.textContent).not.toMatch(/Best for this pool/);
  });

  type Fit = "ok" | "crowded" | "near-edge" | "cross-band";
  const sizedWith = (fits: Record<string, Fit>) => {
    const data = payloadWithAprs({ micro: 40, tight: 35, standard: 32, wide: 29 });
    data.presets = data.presets.map((preset) => {
      const status = fits[preset.id] ?? "ok";
      return {
        ...preset,
        sizeFit: status === "ok"
          ? { status: "ok" as const, ownSharePct: 1, edgeBps: 10, impactBps: 1, bandBps: 5 }
          : { status: "excluded" as const, reason: status, ownSharePct: 1, edgeBps: 10, impactBps: 20, bandBps: 5 },
      };
    });
    return { status: "ready", data } as PoolRangeAprState;
  };
  const noSizeCopy = () => {
    expect(container.textContent).not.toMatch(/doesn't fit|too large for pool depth|large vs pool liquidity|edge near est/);
    expect(container.querySelector(".line-through, .opacity-45, [data-size-fit]")).toBeNull();
  };

  it("hides ranges the deposit does not fit: no button, no Other ranges entry, no strikethrough (SNDK $500)", () => {
    render(sizedWith({ micro: "cross-band", tight: "near-edge" }), { selected: "standard" });
    expect(labels()).toEqual(["Best", "Wide", "Custom"]);
    expect(text("[data-testid='best-resolved']")).toBe("Standard");
    expect(container.querySelector("[data-testid='preset-micro']")).toBeNull();
    expect(container.querySelector("[data-testid='preset-tight']")).toBeNull();
    expect(container.querySelector("[data-testid='apr-micro']")).toBeNull();
    expect(container.querySelector("[data-testid='apr-tight']")).toBeNull();
    expect(text("[data-testid='apr-wide']")).toBe("~29%");
    noSizeCopy();
  });

  it("offers only Best's Wide when every other range is ruled out (SNDK $1000), with a plain note", () => {
    render(sizedWith({ micro: "cross-band", tight: "near-edge", standard: "cross-band", wide: "cross-band" }), { selected: "wide" });
    expect(labels()).toEqual(["Best", "Custom"]);
    expect(text("[data-testid='best-resolved']")).toBe("Wide");
    expect(container.textContent).not.toContain("Other ranges");
    noSizeCopy();
  });

  it("falls back to Best when the selected range stops fitting after the amount changes", () => {
    const { onSelect } = render(sizedWith({}), { selected: "tight" });
    expect(onSelect).not.toHaveBeenCalled();
    act(() => root.render(createElement(RangePresetPicker, {
      presets: OPEN_RANGE_UI_PRESETS, selected: "tight", onSelect, minPrice: "", maxPrice: "",
      onMinPrice: vi.fn(), onMaxPrice: vi.fn(), apr: sizedWith({ micro: "cross-band", tight: "near-edge" }), quotedRange: null,
    })));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("standard");
  });

  it("keeps a custom selection when ranges are hidden", () => {
    const { onSelect } = render(sizedWith({ micro: "cross-band", tight: "near-edge" }), { selected: "custom" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows one plain message and no ranges when the amount fits none of them", () => {
    render(sizedWith({ micro: "crowded", tight: "crowded", standard: "near-edge", wide: "near-edge" }), { selected: "standard" });
    expect(labels()).toEqual(["Custom"]);
    expect(text("[data-testid='lower-amount']")).toBe(LOWER_AMOUNT_TO_OPEN);
    expect(container.querySelector("[data-testid='range-apr-headline']")).toBeNull();
    expect(container.textContent).not.toContain("Other ranges");
    expect(container.textContent).not.toMatch(/Best for this pool|Low confidence|widest range/);
    noSizeCopy();
  });

  it("hides ranges for a real oversized deposit and keeps Best on a fitting one", () => {
    const data = payloadForCapital(payloadFixture(), 150_000);
    render({ status: "ready", data }, { selected: "wide", capitalUsd: 150_000 });
    expect(container.querySelector("[data-testid='preset-micro']")).toBeNull();
    expect(container.querySelector("[data-testid='apr-micro']")).toBeNull();
    noSizeCopy();
  });

  it("shows no number for a custom range on a degraded payload", () => {
    render({ status: "ready", data: degradedPayloadFixture() }, {
      selected: "custom", minPrice: String(uiPriceFromTick(-2.5, 6, 6)), maxPrice: String(uiPriceFromTick(2.5, 6, 6)),
    });
    expect(text("[data-testid='range-apr-headline']")).toBe("—");
  });
});
