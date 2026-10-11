import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseOpenRange } from "./open-api";

describe("parseOpenRange (web quote API)", () => {
  it("accepts the micro preset", () => {
    expect(parseOpenRange({ rangePreset: "micro" })).toEqual({ preset: "micro" });
  });

  it("still defaults to standard and parses custom bands", () => {
    expect(parseOpenRange({})).toEqual({ preset: "standard" });
    expect(parseOpenRange({ rangePreset: "custom", minPrice: "0.99", maxPrice: "1.01" }))
      .toEqual({ preset: "custom", minPrice: "0.99", maxPrice: "1.01" });
  });

  it("rejects unknown presets and incomplete custom ranges", () => {
    expect(() => parseOpenRange({ rangePreset: "yolo" })).toThrow(/micro, tight, standard, wide, or custom/);
    expect(() => parseOpenRange({ rangePreset: "custom", minPrice: "1" })).toThrow(/minPrice and maxPrice/);
  });
});
