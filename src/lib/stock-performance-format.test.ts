import { describe, expect, it } from "vitest";
import { changeTone, formatChangePct, formatShares, formatShortDate, formatUsd } from "./stock-performance-format";

describe("stock performance formats", () => {
  it("formats USD with a real minus sign, a plus only when asked, and no negative zero", () => {
    expect(formatUsd(1752.844)).toBe("$1,752.84");
    expect(formatUsd(-27.125)).toBe("−$27.13");
    expect(formatUsd(18.37, { signed: true })).toBe("+$18.37");
    expect(formatUsd(5.5)).toBe("$5.50");
    expect(formatUsd(-0.004, { signed: true })).toBe("$0.00");
    expect(formatUsd(null)).toBe("—");
  });
  it("formats a change with its arrow", () => {
    expect(formatChangePct(-6.0769)).toBe("↓ 6.08%");
    expect(formatChangePct(3.86)).toBe("↑ 3.86%");
    expect(formatChangePct(undefined)).toBe("—");
  });
  it("formats share counts without trailing zeros", () => {
    expect(formatShares(2.5)).toBe("2.5");
    expect(formatShares(2.53124)).toBe("2.5312");
    expect(formatShares(0.031234)).toBe("0.0312");
    expect(formatShares(0)).toBe("0");
  });
  it("formats the deposit day in UTC", () => {
    expect(formatShortDate("2026-10-20T23:30:00.000Z")).toBe("Oct 20");
    expect(formatShortDate(null)).toBeNull();
  });
  it("colours by the rounded value", () => {
    expect(changeTone(-0.004)).toBe("flat");
    expect(changeTone(-0.01)).toBe("down");
    expect(changeTone(0.5)).toBe("up");
  });
});
