import { describe, expect, it } from "vitest";
import { meteoraSpotBinCounts, meteoraSpotMinimumInput, meteoraSpotRoundsToZero, meteoraSpotSplit } from "./open";

// Live case (2026-11-03, position EKgD…EU on the cbBTC/WBTC pool): range bins −25…34 (60 bins, "standard"), active bin 6.
// The 0.05 USDC open quote bought 30 raw X for 23,750 raw USDC and 33 raw Y for 26,250; a 0.015 add bought 9 X and 10 Y.
const RANGE = { activeId: 6, lowerBinId: -25, upperBinId: 34 };

describe("SpotImBalanced per-bin rounding (too-small deposits)", () => {
  it("counts the bins each side fills: X from the active bin up, Y below it", () => {
    expect(meteoraSpotBinCounts(RANGE.activeId, RANGE.lowerBinId, RANGE.upperBinId)).toEqual({ x: 29, y: 31 });
    expect(meteoraSpotBinCounts(50, -25, 34)).toEqual({ x: 0, y: 60 });
    expect(meteoraSpotBinCounts(-30, -25, 34)).toEqual({ x: 60, y: 0 });
    expect(() => meteoraSpotBinCounts(0, 5, 4)).toThrow(/Invalid bin range/);
  });

  it("the 0.015 USDC add rounds to 0 in every bin (9 X over 29 bins, 10 Y over 31); the 0.05 open does not", () => {
    const bins = meteoraSpotBinCounts(RANGE.activeId, RANGE.lowerBinId, RANGE.upperBinId);
    expect(meteoraSpotRoundsToZero(9n, 10n, bins)).toBe(true);
    expect(meteoraSpotRoundsToZero(30n, 33n, bins)).toBe(false);
    // One short side is enough to refuse: that side would add nothing.
    expect(meteoraSpotRoundsToZero(29n, 30n, bins)).toBe(true);
    expect(meteoraSpotRoundsToZero(0n, 60n, { x: 0, y: 60 })).toBe(false);
  });

  it("minimum input: max over sides of ceil(bins·spend/out) scaled by that side's share (57/120 X, 63/120 Y), +1", () => {
    // X: ceil(29·23750/30) = 22,959 → ceil(22,959·120/57) + 1 = 48,336.  Y: ceil(31·26250/33) = 24,660 → 46,973.
    const minimum = meteoraSpotMinimumInput({ ...RANGE, rates: { x: { spend: 23_750n, out: 30n }, y: { spend: 26_250n, out: 33n } } });
    expect(minimum).toBe(48_336n);
    // At that input the split gives X enough spend for 29 raw out at the observed rate.
    const { x, y } = meteoraSpotSplit(minimum!, RANGE.activeId, RANGE.lowerBinId, RANGE.upperBinId);
    expect(x * 30n / 23_750n).toBeGreaterThanOrEqual(29n);
    expect(y * 33n / 26_250n).toBeGreaterThanOrEqual(31n);
  });

  it("a side kept as-is (out = spend) needs one raw unit per bin; a side with bins but no rate gives null", () => {
    expect(meteoraSpotMinimumInput({ activeId: 50, lowerBinId: -25, upperBinId: 34, rates: { y: { spend: 1n, out: 1n } } })).toBe(61n);
    expect(meteoraSpotMinimumInput({ ...RANGE, rates: { x: { spend: 23_750n, out: 30n } } })).toBeNull();
    expect(meteoraSpotMinimumInput({ ...RANGE, rates: { x: { spend: 1n, out: 0n }, y: { spend: 1n, out: 1n } } })).toBeNull();
  });
});
