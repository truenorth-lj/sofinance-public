import { describe, expect, it } from "vitest";
import { OPEN_RANGE_PRESETS, OPEN_RANGE_UI_PRESETS, DEFAULT_OPEN_RANGE_PRESET } from "./open-range-presets";
import { BEST_HELP } from "./range-apr/copy";
import { quoteOpenPositionSchema } from "../mcp/schemas";

describe("open range presets", () => {
  it("lists the candidates narrow to wide: Micro, then the percent presets", () => {
    expect(OPEN_RANGE_UI_PRESETS.map((preset) => preset.id)).toEqual(["micro", "tight", "standard", "wide"]);
    expect(OPEN_RANGE_UI_PRESETS[0]!.label).toBe("Micro");
    expect(OPEN_RANGE_UI_PRESETS.slice(1).map((preset) => preset.label)).toEqual(OPEN_RANGE_PRESETS.map((preset) => preset.label));
    expect(OPEN_RANGE_UI_PRESETS.map((preset) => preset.shortLabel)).toEqual(["Micro", "Tight", "Standard", "Wide"]);
  });

  it("explains Micro as a fixed centred +-2 step band", () => {
    const help = OPEN_RANGE_UI_PRESETS[0]!.help!;
    expect(help).toMatch(/fixed band/i);
    expect(help).toMatch(/2 .*below and 2 above/i);
    expect(help).not.toMatch(/AI/);
  });

  it("describes Best honestly: highest estimated APR over the last 7 days, not a prediction", () => {
    expect(BEST_HELP).toMatch(/highest estimated fee APR/);
    expect(BEST_HELP).toMatch(/last 7 days/);
    expect(BEST_HELP).toMatch(/Not a prediction/);
    expect(BEST_HELP).toMatch(/risk of leaving range/);
    expect(BEST_HELP).not.toMatch(/\bAI\b/);
  });

  it("keeps Standard as the default preset", () => {
    expect(DEFAULT_OPEN_RANGE_PRESET).toBe("standard");
  });

  it("does not change what MCP publishes: recommendedRanges and the quote schema stay percent-only", () => {
    expect(OPEN_RANGE_PRESETS.map((preset) => preset.id)).toEqual(["tight", "standard", "wide"]);
    expect(quoteOpenPositionSchema.shape.rangePreset.safeParse("micro").success).toBe(false);
    expect(quoteOpenPositionSchema.shape.rangePreset.safeParse("tight").success).toBe(true);
  });
});
