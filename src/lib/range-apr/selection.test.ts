import { describe, expect, it } from "vitest";
import { estimateRangeApr } from "./range-apr";
import { degradedPayloadFixture, payloadFixture as payload } from "./payload.fixture";
import { customTicks, estimateForSelection, toRangeAprInputs } from "./selection";
import { uiPriceFromTick } from "@sofinance/engine/range-apr/tick-math";

describe("estimateForSelection", () => {
  it("returns the server-priced estimate for a preset", () => {
    const data = payload();
    const result = estimateForSelection(data, { preset: "micro", minPrice: "", maxPrice: "" });
    expect(result).toEqual({ status: "ready", range: data.presets[0], estimate: data.presets[0]!.estimate });
  });

  it("prices a custom band in the browser, converting prices to aligned ticks", () => {
    const data = payload();
    const min = String(uiPriceFromTick(-2.5, 6, 6));
    const max = String(uiPriceFromTick(2.5, 6, 6));
    const result = estimateForSelection(data, { preset: "custom", minPrice: min, maxPrice: max });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // Same rounding as the server: lower = floor(tick(min)), upper = floor(tick(max)) aligned up.
    expect(result.range).toEqual({ tickLower: -3, tickUpper: 2 });
    expect(result.estimate).toEqual(estimateRangeApr(toRangeAprInputs(data), { tickLower: -3, tickUpper: 2 }));
  });

  it("flags incomplete and invalid custom input without throwing", () => {
    const data = payload();
    expect(estimateForSelection(data, { preset: "custom", minPrice: "", maxPrice: "1" })).toEqual({ status: "incomplete" });
    expect(estimateForSelection(data, { preset: "custom", minPrice: "1.01", maxPrice: "0.99" })).toEqual({ status: "invalid" });
    expect(estimateForSelection(data, { preset: "custom", minPrice: "abc", maxPrice: "1" })).toEqual({ status: "invalid" });
  });

  it("reports a range beyond the analysed window as unavailable, not an error", () => {
    const data = payload();
    const result = estimateForSelection(data, { preset: "custom", minPrice: "0.5", maxPrice: "2" });
    expect(result).toMatchObject({ status: "ready", estimate: { status: "unavailable", reason: "range-outside-window" } });
  });

  it("prefers the live quote's aligned ticks over the preset ticks", () => {
    const data = payload();
    const result = estimateForSelection(data, { preset: "micro", minPrice: "", maxPrice: "" }, { tickLower: -3, tickUpper: 3 });
    expect(result).toMatchObject({ status: "ready", range: { tickLower: -3, tickUpper: 3 } });
    expect(result.status === "ready" && result.estimate).toEqual(data.presets[1]!.estimate);
  });

  it("falls back to the preset when the quoted ticks are outside the analysed window", () => {
    const data = payload();
    const result = estimateForSelection(data, { preset: "micro", minPrice: "", maxPrice: "" }, { tickLower: -500, tickUpper: 500 });
    expect(result).toEqual({ status: "ready", range: data.presets[0], estimate: data.presets[0]!.estimate });
  });

  it("customTicks needs two valid prices", () => {
    expect(customTicks(payload(), "0.999", "1.001")).not.toBeNull();
    expect(customTicks(payload(), "", "1.001")).toBeNull();
  });
});

describe("estimateForSelection on a degraded payload", () => {
  const unavailable = { status: "unavailable", reason: "degraded-data" };
  const data = () => degradedPayloadFixture();

  it("gives no number for presets, a custom band or a quoted range, whatever the maths would say", () => {
    const min = String(uiPriceFromTick(-2.5, 6, 6));
    const max = String(uiPriceFromTick(2.5, 6, 6));
    expect(estimateForSelection(data(), { preset: "tight", minPrice: "", maxPrice: "" })).toMatchObject({ status: "ready", estimate: unavailable });
    expect(estimateForSelection(data(), { preset: "custom", minPrice: min, maxPrice: max })).toMatchObject({ status: "ready", estimate: unavailable });
    expect(estimateForSelection(data(), { preset: "tight", minPrice: "", maxPrice: "" }, { tickLower: -3, tickUpper: 3 })).toMatchObject({ status: "ready", estimate: unavailable });
  });

  it("still reports an incomplete or invalid custom band as such", () => {
    expect(estimateForSelection(data(), { preset: "custom", minPrice: "", maxPrice: "" })).toEqual({ status: "incomplete" });
    expect(estimateForSelection(data(), { preset: "custom", minPrice: "1.2", maxPrice: "0.8" })).toEqual({ status: "invalid" });
  });
});
