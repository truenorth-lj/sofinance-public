import { describe, expect, it } from "vitest";
import { OPEN_RANGE_UI_PRESETS } from "../open-range-presets";
import { payloadWithAprs } from "./payload.fixture";
import { buildPresetList, highestRangeSummary, pickHighestAprPreset } from "./preset-list";

const ids = (list: ReturnType<typeof buildPresetList>) => list.buttons.map((button) => button.id);

describe("pickHighestAprPreset", () => {
  it("picks the candidate with the highest estimated APR", () => {
    const payload = payloadWithAprs({ micro: 10, tight: 38, standard: 20, wide: 5 });
    expect(pickHighestAprPreset(payload.presets)?.id).toBe("tight");
  });

  it("breaks exact ties in favour of the wider range", () => {
    const payload = payloadWithAprs({ micro: 20, tight: 20, standard: 20, wide: 5 });
    expect(pickHighestAprPreset(payload.presets)?.id).toBe("standard");
    // Float noise is still a tie.
    expect(pickHighestAprPreset(payloadWithAprs({ micro: 20, tight: 20 + 1e-12, standard: 1, wide: 1 }).presets)?.id).toBe("tight");
    expect(pickHighestAprPreset(payloadWithAprs({ micro: 20 + 1e-12, tight: 20, standard: 1, wide: 1 }).presets)?.id).toBe("tight");
  });

  it("does not let a tie override a genuinely higher APR on a narrower range", () => {
    expect(pickHighestAprPreset(payloadWithAprs({ micro: 30, tight: 20, standard: 20, wide: 20 }).presets)?.id).toBe("micro");
  });

  it("between identical tick ranges prefers the wider-named (later) candidate", () => {
    const payload = payloadWithAprs({ micro: 50, tight: 5, standard: 5, wide: 50 }, { micro: [-60, 60], wide: [-60, 60] });
    expect(pickHighestAprPreset(payload.presets)?.id).toBe("wide");
  });

  it("ignores unavailable candidates", () => {
    const payload = payloadWithAprs({ micro: null, tight: null, standard: 7, wide: null });
    expect(pickHighestAprPreset(payload.presets)?.id).toBe("standard");
  });

  it("returns null when every candidate is unavailable or there are none", () => {
    expect(pickHighestAprPreset(payloadWithAprs({ micro: null, tight: null, standard: null, wide: null }).presets)).toBeNull();
    expect(pickHighestAprPreset([])).toBeNull();
  });

  it("treats a 0% estimate as a usable candidate", () => {
    expect(pickHighestAprPreset(payloadWithAprs({ micro: 0, tight: null, standard: null, wide: null }).presets)?.id).toBe("micro");
  });
});

describe("buildPresetList", () => {
  it("falls back to the plain row without AI best while there is no payload (loading / error)", () => {
    const list = buildPresetList(OPEN_RANGE_UI_PRESETS, null);
    expect(list.aiBest).toBeNull();
    expect(ids(list)).toEqual(["micro", "tight", "standard", "wide"]);
    expect(list.buttons.every((button) => button.estimate === null)).toBe(true);
  });

  it("falls back to the plain row when no candidate has an estimate", () => {
    const list = buildPresetList(OPEN_RANGE_UI_PRESETS, payloadWithAprs({ micro: null, tight: null, standard: null, wide: null }));
    expect(list.aiBest).toBeNull();
    expect(ids(list)).toEqual(["micro", "tight", "standard", "wide"]);
  });

  it("moves the resolved candidate into AI best and keeps the rest narrow to wide", () => {
    const list = buildPresetList(OPEN_RANGE_UI_PRESETS, payloadWithAprs({ micro: 10, tight: 38, standard: 20, wide: 5 }));
    expect(list.aiBest).toMatchObject({ id: "tight", resolvedLabel: "Tight" });
    expect(list.aiBest?.estimate).toMatchObject({ status: "ok", aprPct: 38 });
    expect(ids(list)).toEqual(["micro", "standard", "wide"]);
  });

  it("never lists the resolved candidate twice, whichever one it is", () => {
    for (const winner of ["micro", "tight", "standard", "wide"] as const) {
      const aprs = { micro: 1, tight: 2, standard: 3, wide: 4, [winner]: 99 };
      const list = buildPresetList(OPEN_RANGE_UI_PRESETS, payloadWithAprs(aprs));
      expect(list.aiBest?.id).toBe(winner);
      expect(ids(list)).not.toContain(winner);
      expect(ids(list)).toEqual(["micro", "tight", "standard", "wide"].filter((id) => id !== winner));
    }
  });

  it("keeps unavailable candidates as buttons (they show a dash), after the AI best pick", () => {
    const list = buildPresetList(OPEN_RANGE_UI_PRESETS, payloadWithAprs({ micro: null, tight: 9, standard: null, wide: 3 }));
    expect(list.aiBest?.id).toBe("tight");
    expect(list.buttons.map((button) => [button.id, button.estimate?.status])).toEqual([
      ["micro", "unavailable"], ["standard", "unavailable"], ["wide", "ok"],
    ]);
  });

  it("also drops candidates that cover exactly the same ticks as the resolved one", () => {
    const payload = payloadWithAprs({ micro: 50, tight: 5, standard: 4, wide: 50 }, { micro: [-60, 60], wide: [-60, 60] });
    const list = buildPresetList(OPEN_RANGE_UI_PRESETS, payload);
    expect(list.aiBest?.id).toBe("wide");
    expect(ids(list)).toEqual(["tight", "standard"]);
  });

  it("shows the short range name (no percentage) in AI best", () => {
    const list = buildPresetList(OPEN_RANGE_UI_PRESETS, payloadWithAprs({ standard: 99 }));
    expect(list.aiBest?.resolvedLabel).toBe("Standard");
    expect(list.buttons.find((button) => button.id === "tight")?.label).toBe("Tight (±0.05%)");
  });
});

describe("highestRangeSummary", () => {
  it("matches what the modal's AI best button resolves to", () => {
    const payload = payloadWithAprs({ micro: 10, tight: 38, standard: 20, wide: 5 });
    expect(highestRangeSummary(OPEN_RANGE_UI_PRESETS, payload)).toEqual({ id: "tight", label: "Tight", aprPct: 38 });
    expect(highestRangeSummary(OPEN_RANGE_UI_PRESETS, payload)?.id).toBe(buildPresetList(OPEN_RANGE_UI_PRESETS, payload).aiBest?.id);
  });

  it("is null when nothing is available", () => {
    expect(highestRangeSummary(OPEN_RANGE_UI_PRESETS, payloadWithAprs({ micro: null, tight: null, standard: null, wide: null }))).toBeNull();
  });
});
