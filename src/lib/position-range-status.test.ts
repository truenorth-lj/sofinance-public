import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { describe, expect, it } from "vitest";
import { rangeStatusFromPrice } from "./position-range-status";
import { uiPriceBPerAFromTick } from "@sofinance/engine/position-performance-math";


describe("rangeStatusFromPrice", () => {
  const tickLower = -100;
  const tickUpper = 100;
  const mid = uiPriceBPerAFromTick(0, 6, 6);
  const lower = uiPriceBPerAFromTick(tickLower, 6, 6);
  const upper = uiPriceBPerAFromTick(tickUpper, 6, 6);

  it("reports inside at the tick mid and not near an edge", () => {
    const status = rangeStatusFromPrice({
      priceBPerA: mid,
      tickLower,
      tickUpper,
      decimalsA: 6,
      decimalsB: 6,
      priceSource: "on-chain",
    });
    expect(status.inRange).toBe(true);
    expect(status.rangeSide).toBe("inside");
    expect(status.nearEdge).toBe(false);
    expect(status.priceSource).toBe("on-chain");
    expect(status.distanceToLowerPct).toBeCloseTo(((mid - lower) / (upper - lower)) * 100, 8);
    expect(status.distanceToLowerPricePct).toBeCloseTo(((mid - lower) / lower) * 100, 8);
    expect(status.distanceToUpperPricePct).toBeCloseTo(((upper - mid) / upper) * 100, 8);
    expect(status.distanceToLowerPricePct).not.toBe(status.distanceToLowerPct);
  });

  it("flags a near-edge approach on the lower bound", () => {
    const width = upper - lower;
    const price = lower + width * 0.04;
    const status = rangeStatusFromPrice({
      priceBPerA: price,
      tickLower,
      tickUpper,
      decimalsA: 6,
      decimalsB: 6,
    });
    expect(status.inRange).toBe(true);
    expect(status.nearEdge).toBe(true);
    expect(status.edge).toBe("lower");
  });

  it("reports below / above when the price leaves the band", () => {
    expect(
      rangeStatusFromPrice({
        priceBPerA: lower * 0.5,
        tickLower,
        tickUpper,
        decimalsA: 6,
        decimalsB: 6,
      }).rangeSide,
    ).toBe("below");
    expect(
      rangeStatusFromPrice({
        priceBPerA: upper * 1.5,
        tickLower,
        tickUpper,
        decimalsA: 6,
        decimalsB: 6,
      }).rangeSide,
    ).toBe("above");
  });

  it("matches Raydium tick-mid orientation for a 1:1 band", () => {
    const sqrt = TickUtil.getSqrtPriceAtTick(0);
    expect(Number(TickUtil.sqrtPriceX64ToPrice(sqrt, 6, 6).toString())).toBeCloseTo(mid, 8);
  });
});
