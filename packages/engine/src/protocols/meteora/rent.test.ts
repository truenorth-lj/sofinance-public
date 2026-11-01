import { describe, expect, it } from "vitest";
import { meteoraPositionAccountSize } from "./rent";

describe("Meteora position account size", () => {
  it("base account up to 70 bins, +112 bytes per extra bin, at most 1,400 bins", () => {
    expect(meteoraPositionAccountSize(1)).toBe(8120);
    expect(meteoraPositionAccountSize(70)).toBe(8120);
    expect(meteoraPositionAccountSize(200)).toBe(8120 + 130 * 112);
    expect(meteoraPositionAccountSize(1400)).toBe(8120 + 1330 * 112);
    for (const width of [0, 1401, 2.5]) expect(() => meteoraPositionAccountSize(width)).toThrow(/width/);
  });
});
