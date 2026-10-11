import { describe, expect, it } from "vitest";
import { parseRaydiumPoolEconomics } from "./raydium-economics";

const pool = {
  mintA: { address: "A", decimals: 6 }, mintB: { address: "B", decimals: 8 },
  feeRate: 0.0005, tvl: 5796.45, price: 1.0008, mintAmountA: 0.04, mintAmountB: 35.5,
  config: { protocolFeeRate: 120000, fundFeeRate: 40000, tickSpacing: 1 },
  day: { feeApr: 6.02, volume: 1910 }, week: { feeApr: 9.8, volume: 37791.5 },
};

describe("parseRaydiumPoolEconomics", () => {
  it("reads the fields the estimate needs", () => {
    expect(parseRaydiumPoolEconomics({ success: true, data: [pool] })).toEqual({
      mintA: "A", mintB: "B", decimalsA: 6, decimalsB: 8, feeRate: 0.0005, tvlUsd: 5796.45, price: 1.0008,
      mintAmountA: 0.04, mintAmountB: 35.5, protocolFeeRate: 120000, fundFeeRate: 40000,
      weekVolumeUsd: 37791.5, dayFeeApr: 6.02, weekFeeApr: 9.8,
    });
  });

  it("accepts numeric strings and tolerates a missing config / windows", () => {
    const parsed = parseRaydiumPoolEconomics({ data: [{ ...pool, feeRate: "0.001", config: undefined, week: undefined, day: undefined }] });
    expect(parsed).toMatchObject({ feeRate: 0.001, protocolFeeRate: null, fundFeeRate: null, weekVolumeUsd: null, dayFeeApr: null });
  });

  it("is null for failed, empty or incomplete responses", () => {
    expect(parseRaydiumPoolEconomics(null)).toBeNull();
    expect(parseRaydiumPoolEconomics({ success: false, data: [pool] })).toBeNull();
    expect(parseRaydiumPoolEconomics({ success: true, data: [] })).toBeNull();
    expect(parseRaydiumPoolEconomics({ data: [{ ...pool, tvl: undefined }] })).toBeNull();
    expect(parseRaydiumPoolEconomics({ data: [{ ...pool, mintA: { address: "A" } }] })).toBeNull();
    expect(parseRaydiumPoolEconomics({ data: [{ ...pool, feeRate: -1 }] })).toBeNull();
  });
});
