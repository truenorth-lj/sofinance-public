import { describe, expect, it } from "vitest";
import { NATIVE_SOL_MINT, USDC_MINT } from "./ids";
import {
  formatFeeTier,
  formatPositionLabel,
  formatPositionPriceRange,
  formatRangeStatus,
  shortMint,
  tokenSymbol,
} from "./position-label";

const POSITION_MINT = "33333333333333333333333333333333";
const MINT_A = "11111111111111111111111111111111";
const MINT_B = "22222222222222222222222222222222";

describe("shortMint", () => {
  it("keeps short values and truncates longer mints", () => {
    expect(shortMint("abcd")).toBe("abcd");
    expect(shortMint(POSITION_MINT)).toBe("3333…3333");
  });
});

describe("tokenSymbol", () => {
  it("prefers metadata, then known mints, then a shortened mint", () => {
    expect(tokenSymbol(MINT_A, { [MINT_A]: { symbol: " SPCXx " } })).toBe("SPCXx");
    expect(tokenSymbol(USDC_MINT)).toBe("USDC");
    expect(tokenSymbol(NATIVE_SOL_MINT)).toBe("WSOL");
    expect(tokenSymbol(MINT_B)).toBe("2222…2222");
    expect(tokenSymbol(MINT_B, { [MINT_B]: { symbol: "" } })).toBe("2222…2222");
  });
});

describe("formatRangeStatus", () => {
  it("uses plain-language range sides", () => {
    expect(formatRangeStatus("inside")).toBe("In range");
    expect(formatRangeStatus("above")).toBe("Above range");
    expect(formatRangeStatus("below")).toBe("Below range");
    expect(formatRangeStatus("")).toBeNull();
    expect(formatRangeStatus(undefined)).toBeNull();
  });
});

describe("formatFeeTier", () => {
  it("renders common CLMM tiers as a percent", () => {
    expect(formatFeeTier(1)).toBe("0.01% fee");
    expect(formatFeeTier(5)).toBe("0.05% fee");
    expect(formatFeeTier(25)).toBe("0.25% fee");
    expect(formatFeeTier(100)).toBe("1% fee");
    expect(formatFeeTier(null)).toBeNull();
    expect(formatFeeTier(-1)).toBeNull();
  });
});

describe("formatPositionPriceRange", () => {
  it("converts ticks to a human B-per-A range without a double minus", () => {
    // Same orientation as Positions page / TE mid: 1.0001^tick × 10^(decA−decB).
    expect(formatPositionPriceRange({
      tickLower: 46054,
      tickUpper: 46058,
      decimalsA: 6,
      decimalsB: 8,
    })).toBe("1.0000–1.0004");

    expect(formatPositionPriceRange({
      tickLower: 12,
      tickUpper: 16,
      decimalsA: 6,
      decimalsB: 6,
    })).toBe("1.0012–1.0016");
  });

  it("falls back to 'to' between negative ticks so the range is readable", () => {
    expect(formatPositionPriceRange({
      tickLower: -46080,
      tickUpper: -46020,
    })).toBe("-46080 to -46020");
    expect(formatPositionPriceRange({
      tickLower: -46080,
      tickUpper: -46020,
      decimalsA: -1,
      decimalsB: 6,
    })).toBe("-46080 to -46020");
  });
});

describe("formatPositionLabel", () => {
  it("labels a wrap-pair position by symbols, fee, price range, status, and short NFT", () => {
    expect(
      formatPositionLabel(
        {
          positionMint: POSITION_MINT,
          mintA: MINT_A,
          mintB: MINT_B,
          tickLower: 12,
          tickUpper: 16,
          rangeSide: "inside",
          decimalsA: 6,
          decimalsB: 6,
          feeTierBps: 1,
        },
        { [MINT_A]: { symbol: "SPCXx" }, [MINT_B]: { symbol: "SPCX" } },
      ),
    ).toBe("SPCXx/SPCX · 0.01% fee · range 1.0012–1.0016 · In range · #3333…3333");
  });

  it("omits fee when unknown and still distinguishes out-of-range sides", () => {
    expect(
      formatPositionLabel({
        positionMint: POSITION_MINT,
        mintA: MINT_A,
        mintB: MINT_B,
        tickLower: -20,
        tickUpper: -10,
        rangeSide: "above",
        decimalsA: 6,
        decimalsB: 6,
      }),
    ).toBe("1111…1111/2222…2222 · range 0.9980–0.9990 · Above range · #3333…3333");
  });
});
