// Withdraw share → bps (PM review of #289): rounded, so 57% is 5700 (floor gave 5699); only exactly 100% closes.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { meteoraWithdrawBps } from "./manage.server";

describe("meteoraWithdrawBps", () => {
  it("rounds to the nearest bps, never 0, and only 1 is the full 10,000", () => {
    expect(meteoraWithdrawBps(0.57)).toBe(5700);
    expect(meteoraWithdrawBps(0.29)).toBe(2900);
    for (let percent = 1; percent < 100; percent++) expect(meteoraWithdrawBps(percent / 100)).toBe(percent * 100);
    expect(meteoraWithdrawBps(1)).toBe(10_000);
    expect(meteoraWithdrawBps(0.99999)).toBe(9_999);
    expect(meteoraWithdrawBps(0.000001)).toBe(1);
    expect(() => meteoraWithdrawBps(0)).toThrow();
  });
});
