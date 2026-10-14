import { describe, expect, it } from "vitest";
import { volumeDivergenceNote, volumeRatio } from "./volume-divergence";

describe("volumeRatio", () => {
  it("divides 24h by the 7d average", () => expect(volumeRatio(300, 100)).toBe(3));
  it.each([[null, 100], [100, null], [undefined, 100], [100, 0], [-1, 100], [Number.NaN, 100], [100, Infinity]])(
    "returns null for %s / %s", (a, b) => expect(volumeRatio(a, b)).toBeNull(),
  );
});

describe("volumeDivergenceNote", () => {
  it("runs hot above 2x", () =>
    expect(volumeDivergenceNote(345, 100)).toBe("Today's volume is 3.5× the 7-day average, so the 24h number runs hot."));
  it("runs cold below 0.5x", () =>
    expect(volumeDivergenceNote(30, 100)).toBe("Today's volume is 0.3× the 7-day average, so the 24h number runs cold."));
  it("is silent within 2x either way, including the boundaries", () => {
    expect(volumeDivergenceNote(200, 100)).toBeNull();
    expect(volumeDivergenceNote(50, 100)).toBeNull();
    expect(volumeDivergenceNote(100, 100)).toBeNull();
  });
  it("is silent when data is missing", () => expect(volumeDivergenceNote(500, null)).toBeNull());
  it("honours a custom threshold", () => expect(volumeDivergenceNote(150, 100, 1.2)).toContain("1.5×"));
});
