import { describe, expect, it } from "vitest";
import { daysWord } from "./format";

describe("daysWord", () => {
  it("uses the singular for one day", () => {
    expect(daysWord(1)).toBe("day");
    expect(daysWord(0)).toBe("days");
    expect(daysWord(2)).toBe("days");
  });
});
