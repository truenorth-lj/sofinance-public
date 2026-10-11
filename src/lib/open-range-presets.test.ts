import { describe, expect, it } from "vitest";
import { OPEN_RANGE_PRESETS, OPEN_RANGE_UI_PRESETS, DEFAULT_OPEN_RANGE_PRESET } from "./open-range-presets";
import { quoteOpenPositionSchema } from "../mcp/schemas";

describe("open range presets", () => {
  it("shows the AI pick to the LEFT of Tight, followed by the percent presets", () => {
    expect(OPEN_RANGE_UI_PRESETS.map((preset) => preset.id)).toEqual(["ai", "tight", "standard", "wide"]);
    expect(OPEN_RANGE_UI_PRESETS[0]!.label).toBe("AI pick");
    expect(OPEN_RANGE_UI_PRESETS.slice(1).map((preset) => preset.label)).toEqual(OPEN_RANGE_PRESETS.map((preset) => preset.label));
  });

  it("is honest in its help text: a fixed centred +-2 step rule, not an AI model", () => {
    const help = OPEN_RANGE_UI_PRESETS[0]!.help!;
    expect(help).toMatch(/fixed rule/i);
    expect(help).toMatch(/not an AI model/i);
    expect(help).toMatch(/2 .*below and 2 above/i);
  });

  it("keeps Standard as the default preset", () => {
    expect(DEFAULT_OPEN_RANGE_PRESET).toBe("standard");
  });

  it("does not change what MCP publishes: recommendedRanges and the quote schema stay percent-only", () => {
    expect(OPEN_RANGE_PRESETS.map((preset) => preset.id)).toEqual(["tight", "standard", "wide"]);
    expect(quoteOpenPositionSchema.shape.rangePreset.safeParse("ai").success).toBe(false);
    expect(quoteOpenPositionSchema.shape.rangePreset.safeParse("tight").success).toBe(true);
  });
});
