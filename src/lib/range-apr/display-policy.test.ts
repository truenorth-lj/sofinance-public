import { describe, expect, it } from "vitest";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { cardPayloadWithAprs, degradedPayloadFixture, payloadFixture } from "./payload.fixture";
import { rangeAprPayload } from "./display-policy";
import { tslaPayload } from "./tsla-payload.fixture";
import { estimateForSelection } from "./selection";
import { buildPresetList, highestRangeSummary } from "./preset-list";
import { summarizeApr7d } from "@/lib/unified-pools/apr7d";

const ui = OPEN_RANGE_UI_PRESETS;

describe("shared Best policy", () => {
  it("recomputes Best and APR for a valued typed amount, without mutating the served snapshot", () => {
    const before = JSON.stringify(tslaPayload);
    const small = highestRangeSummary(ui, rangeAprPayload(tslaPayload, 100));
    const larger = highestRangeSummary(ui, rangeAprPayload(tslaPayload, 300));
    expect(small?.id).toBe("tight");
    expect(larger?.id).toBe("standard");
    expect(larger?.aprPct).not.toBe(small?.aprPct);
    expect(JSON.stringify(tslaPayload)).toBe(before);
  });
  it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])("uses the common preview for invalid/unvalued capital %s", (capital) => {
    expect(rangeAprPayload(payloadFixture(), capital)).toEqual(rangeAprPayload(payloadFixture(), 1000));
  });
  it("retains same-capital server estimates rather than recalculating hand-set reference APRs", () => {
    const data = cardPayloadWithAprs({ micro: 40, tight: 30, standard: 20, wide: 10 });
    const priced = rangeAprPayload(data, 1000);
    expect(priced.presets[0]!.estimate).toBe(data.presets[0]!.estimate);
    expect(priced.presets.every((preset) => preset.sizeFit?.status === "ok")).toBe(true);
  });
  it("excludes the same thin-pool candidates on the card and the form at the preview basis", () => {
    const base = payloadFixture();
    const data = { ...base, model: { ...base.model, bins: base.model.bins.map((bin) => ({ ...bin, liquidity: 1e7 })) } };
    const preview = rangeAprPayload(data);
    expect(preview.presets.find((preset) => preset.id === "micro")?.sizeFit?.status).toBe("excluded");
    const best = highestRangeSummary(ui, preview)!;
    expect(best.id).not.toBe("micro");
    expect(buildPresetList(ui, preview).buttons.some((preset) => preset.id === "micro")).toBe(false);
    expect(summarizeApr7d(data, "raydium-clmm", Date.parse(data.fetchedAt)))
      .toMatchObject({ status: "ready", aprPct: best.aprPct, rangeLabel: ui.find((preset) => preset.id === best.id)!.label });
  });
  it("caps preset, custom and quoted headlines at the same observed whole-pool LP fees", () => {
    const data = cardPayloadWithAprs({ micro: 100, tight: 80, standard: 60, wide: 40 });
    data.model.avgDailyVolumeUsd = 0.001; // The observed total is lower than the model's bin allocation.
    const priced = rangeAprPayload(data);
    const cap = 0.001 * data.pool.feeRate * data.pool.lpFeeFraction * 365 / 1000 * 100;
    const summary = highestRangeSummary(ui, priced)!;
    expect(summary.aprPct).toBeCloseTo(cap, 12);
    expect(summarizeApr7d(data, "raydium-clmm", Date.parse(data.fetchedAt))).toMatchObject({ status: "ready", aprPct: summary.aprPct });
    for (const result of [
      estimateForSelection(priced, { preset: summary.id, minPrice: "", maxPrice: "" }),
      estimateForSelection(priced, { preset: "custom", minPrice: "0.9998", maxPrice: "1.0002" }),
      estimateForSelection(priced, { preset: "micro", minPrice: "", maxPrice: "" }, { tickLower: -3, tickUpper: 3 }),
    ]) {
      expect(result).toMatchObject({ status: "ready", estimate: { status: "ok" } });
      if (result.status === "ready" && result.estimate.status === "ok") expect(result.estimate.aprPct).toBeCloseTo(cap, 12);
    }
  });
  it("keeps degraded and new-pool card states without inventing a Best", () => {
    const data = degradedPayloadFixture();
    expect(rangeAprPayload(data, 500)).toBe(data);
    expect(highestRangeSummary(ui, rangeAprPayload(data))).toBeNull();
    expect(summarizeApr7d(data, "raydium-clmm", Date.parse(data.fetchedAt))).toMatchObject({ status: "missing", degraded: true });
    const young = payloadFixture();
    young.sample.dataDays = 3;
    expect(summarizeApr7d(young, "raydium-clmm", Date.parse(young.fetchedAt))).toMatchObject({ status: "new", days: 3 });
  });
  it("does not resurrect unavailable server estimates when switching preview capital", () => {
    const payload = payloadFixture();
    payload.presets = payload.presets.map((preset) => ({ ...preset, estimate: { status: "unavailable", reason: "range-outside-window" } }));
    expect(highestRangeSummary(ui, rangeAprPayload(payload))).toBeNull();
  });
  it.each([100, 1000])("removes Raydium fit metadata with enforcement off at reference capital %s", (referenceCapitalUsd) => {
    const payload = payloadFixture({ referenceCapitalUsd });
    payload.presets = payload.presets.map((preset) => ({ ...preset, sizeFit: {
      status: "excluded", reason: "cross-band", ownSharePct: 1, edgeBps: 100, impactBps: 2, bandBps: 1,
    } }));
    const before = JSON.stringify(payload);
    const priced = rangeAprPayload(payload, 1000, { enforceSizeFit: false });
    expect(priced.referenceCapitalUsd).toBe(1000);
    for (const preset of priced.presets) expect(preset).not.toHaveProperty("sizeFit");
    expect(highestRangeSummary(ui, priced)).not.toBeNull();
    expect(JSON.stringify(payload)).toBe(before);
  });
  it("does not promote any excluded range, including cross-band, when every candidate is excluded", () => {
    const payload = cardPayloadWithAprs({ micro: 40, tight: 30, standard: 20, wide: 10 });
    payload.presets = payload.presets.map((preset) => ({ ...preset, sizeFit: {
      status: "excluded", reason: "cross-band", ownSharePct: 1, edgeBps: 100, impactBps: 2, bandBps: 1,
    } }));
    const data = rangeAprPayload(payload);
    expect(buildPresetList(ui, data)).toEqual({ best: null, buttons: [], tooLarge: true });
    expect(summarizeApr7d(payload, "raydium-clmm", Date.parse(payload.fetchedAt)).status).toBe("missing");
  });
});
