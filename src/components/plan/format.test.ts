import { describe, expect, it } from "vitest";
import { bestAprCopy, completeDaysCopy, daysWord, formatSignedPct } from "./format";

describe("daysWord", () => {
  it("uses the singular for one day", () => {
    expect(daysWord(1)).toBe("day");
    expect(daysWord(0)).toBe("days");
    expect(daysWord(2)).toBe("days");
  });
});

describe("plan copy helpers", () => {
  it("formats a signed percent to two places and drops a zero", () => {
    expect(formatSignedPct("2.0441")).toBe("+2.04%");
    expect(formatSignedPct("0.5")).toBe("+0.5%");
    expect(formatSignedPct("-0.5")).toBe("−0.5%");
    expect(formatSignedPct("0.001")).toBe("0%");
  });

  it("words the sample and the best-APR window", () => {
    expect(completeDaysCopy(1)).toBe("1 complete UTC day");
    expect(completeDaysCopy(29)).toBe("29 complete UTC days");
    expect(bestAprCopy({ windowDays: 7, aprPct: "19.21034" })).toBe("7-day average fee APR of 19.2%");
  });
});
