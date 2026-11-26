import { describe, expect, it } from "vitest";
import {
  effectiveScaledUiMultiplier,
  fairPriceFor,
  formatFairPriceLine,
  formatShareMultiplier,
  rawPriceBPerA,
  scaledUiFairNote,
} from "./fair-price";

describe("fairPriceFor", () => {
  it("returns the NVDAx fair price and share line when the pool is close to fair", () => {
    const result = fairPriceFor({
      symbolA: "NVDA",
      symbolB: "NVDAx",
      multiplierA: 1,
      multiplierB: 1.001701,
      price: 0.99950,
    });
    expect(result).not.toBeNull();
    expect(result!.fair).toBeCloseTo(1 / 1.001701, 8);
    expect(result!.shareLines).toEqual(["1 NVDAx = 1.0017 shares"]);
  });

  it("returns the SPYx fair price and share line when the pool trades at fair", () => {
    const result = fairPriceFor({
      symbolA: "SPY",
      symbolB: "SPYx",
      multiplierA: 1,
      multiplierB: 1.007474,
      price: 0.99249,
    });
    expect(result).not.toBeNull();
    expect(result!.fair).toBeCloseTo(1 / 1.007474, 8);
    expect(result!.shareLines).toEqual(["1 SPYx = 1.0075 shares"]);
  });

  it("returns null for SNDK, whose multiplier (8) is far from the ~1 pool price", () => {
    expect(
      fairPriceFor({
        symbolA: "SNDK",
        symbolB: "SNDKx",
        multiplierA: 8,
        multiplierB: 1,
        price: 0.99875,
      }),
    ).toBeNull();
  });

  it("returns a fair price of 1 and no share lines for a pool whose multipliers are 1", () => {
    const result = fairPriceFor({
      symbolA: "TSLA",
      symbolB: "TSLAx",
      multiplierA: 1,
      multiplierB: 1,
      price: 1.0004,
    });
    expect(result).toEqual({ fair: 1, multiplierA: 1, multiplierB: 1, shareLines: [] });
  });

  it("returns null when the price is more than 2% from fair, and when inputs are not usable", () => {
    const base = { symbolA: "A", symbolB: "B", multiplierA: 1, multiplierB: 1.01, price: 1 / 1.01 };
    expect(fairPriceFor({ ...base, price: (1 / 1.01) * 1.021 })).toBeNull();
    expect(fairPriceFor({ ...base, price: (1 / 1.01) * 0.979 })).toBeNull();
    expect(fairPriceFor({ ...base, price: Number.NaN })).toBeNull();
    expect(fairPriceFor({ ...base, multiplierA: 0 })).toBeNull();
  });
});

describe("rawPriceBPerA", () => {
  it("leaves a Raydium (raw) price unchanged and converts a Meteora share-adjusted price back to raw", () => {
    const multiplierA = 1, multiplierB = 1.030927835; // fair ≈ 0.97
    const raw = 0.97;
    const share = raw * (multiplierB / multiplierA);
    expect(rawPriceBPerA({ multiplierA, multiplierB, priceBPerA: raw })).toBeCloseTo(raw, 12);
    expect(rawPriceBPerA({ protocol: "raydium-clmm", multiplierA, multiplierB, priceBPerA: raw })).toBeCloseTo(raw, 12);
    expect(rawPriceBPerA({ protocol: "meteora-dlmm", multiplierA, multiplierB, priceBPerA: share })).toBeCloseTo(raw, 12);
  });
});

describe("scaledUiFairNote", () => {
  const nvda = {
    symbolA: "NVDA",
    symbolB: "NVDAx",
    pairLabel: "NVDAx/NVDA",
    multiplierA: 1,
    multiplierB: 1.001701,
    priceBPerA: 0.99950,
  };

  it("uses pairLabel order and unit-bearing fair price, e.g. 1 NVDAx ≈ 1.0017 NVDA", () => {
    expect(formatFairPriceLine({ symbolA: "NVDA", symbolB: "NVDAx", fair: 1 / 1.001701, pairLabel: "NVDAx/NVDA" }))
      .toBe("Fair price: 1 NVDAx ≈ 1.0017 NVDA");
    expect(scaledUiFairNote(nvda)).toBe("1 NVDAx = 1.0017 shares. Fair price: 1 NVDAx ≈ 1.0017 NVDA");
  });

  it("shows no note when both sides are 8, because the fair price is 1", () => {
    expect(
      scaledUiFairNote({
        symbolA: "SNDK",
        symbolB: "SNDKx",
        pairLabel: "SNDKx/SNDK",
        multiplierA: 8,
        multiplierB: 8,
        priceBPerA: 0.99863,
      }),
    ).toBeNull();
  });

  it("still shows the NVDAx note when a Meteora price already includes the multiplier", () => {
    const sharePrice = 0.99950 * (1.001701 / 1);
    const note = scaledUiFairNote({
      ...nvda,
      protocol: "meteora-dlmm",
      priceBPerA: sharePrice,
    });
    expect(note).toBe("1 NVDAx = 1.0017 shares. Fair price: 1 NVDAx ≈ 1.0017 NVDA");
    // Without the conversion, a share price of 1 with fair 0.97 would be wrongly dropped.
    const far = { symbolA: "NVDA", symbolB: "NVDAx", pairLabel: "NVDAx/NVDA", multiplierA: 1, multiplierB: 1 / 0.97, priceBPerA: 1, protocol: "meteora-dlmm" as const };
    expect(scaledUiFairNote(far)).toContain("Fair price: 1 NVDAx ≈");
    expect(scaledUiFairNote({ ...far, protocol: "raydium-clmm" })).toBeNull();
  });
});

describe("effectiveScaledUiMultiplier", () => {
  it("uses newMultiplier once the effective timestamp has passed, otherwise the current multiplier", () => {
    const now = Date.UTC(2026, 10, 20);
    expect(effectiveScaledUiMultiplier({ multiplier: 1.000918, newMultiplier: 1.001701, newMultiplierEffectiveTimestamp: now / 1000 - 1 }, now)).toBe(1.001701);
    expect(effectiveScaledUiMultiplier({ multiplier: 1.000918, newMultiplier: 1.001701, newMultiplierEffectiveTimestamp: now / 1000 + 60 }, now)).toBe(1.000918);
  });
});

describe("formatShareMultiplier", () => {
  it("matches the NVDAx display to four decimals", () => {
    expect(formatShareMultiplier(1.001701)).toBe("1.0017");
  });

  it("uses more than four decimals when four would hide a small step away from 1", () => {
    expect(formatShareMultiplier(1.00004)).toBe("1.00004");
  });

  it("trims float noise to 1 or to a whole number, rather than expanding digits", () => {
    expect(formatShareMultiplier(1.000000007)).toBe("1");
    expect(formatShareMultiplier(8.000000056997418)).toBe("8");
  });
});

describe("official LST fair price (SOL/hSOL stake-pool rate)", () => {
  const solPerHsol = 1.198025;
  const ray = {
    symbolA: "SOL",
    symbolB: "hSOL",
    multiplierA: 1,
    multiplierB: 1,
    fairPriceBPerA: 1 / solPerHsol,
    price: 1 / 1.1967,
  };

  it("uses the official rate instead of the 1/1 multiplier ratio, and the 2% gate passes", () => {
    const result = fairPriceFor(ray);
    expect(result?.fair).toBeCloseTo(1 / solPerHsol, 10);
    expect(scaledUiFairNote({ ...ray, priceBPerA: ray.price, protocol: "raydium-clmm", pairLabel: "SOL/hSOL" }))
      .toMatch(/^Fair price: 1 SOL ≈ 0\.8347\d* hSOL$/);
  });

  it("drops the note when no official rate is provided (multiplier fair of 1 fails the 2% gate)", () => {
    const { fairPriceBPerA: _ignored, ...without } = ray;
    expect(fairPriceFor(without)).toBeNull();
    expect(scaledUiFairNote({ ...without, priceBPerA: ray.price, protocol: "raydium-clmm" })).toBeNull();
  });
});
