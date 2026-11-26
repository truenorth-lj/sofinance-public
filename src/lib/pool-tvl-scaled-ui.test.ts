import { describe, expect, it } from "vitest";
import { knownMultiplier, tvlLeavesOutScaledUi, withScaledUiTvl, withUsdPerShare } from "./pool-tvl-scaled-ui";
import type { RwaPairRow } from "./rwa-pairs";

// Meteora NVDA/NVDAx (design P2): datapi TVL, amounts and prices as captured 2026-11-21.
const meteora = {
  poolAddress: "Aq7nhS8pDPRvPA2uWotwyk79aG8Hfegf5CdA3iXABxAR", protocol: "meteora-dlmm", tvlUsd: 39_347.15291483027, fees24hUsd: 50.87,
  estimatedFeeAprPct: 50.87 / 39_347.15291483027 * 365 * 100,
  tvlSides: { amountA: 90.630577, amountB: 218.226743296602, sharePriceUsdA: 127.40917157110418, sharePriceUsdB: 127.61290212453196 },
} as RwaPairRow;
const NVDAX = { multiplier: 1.000918, newMultiplier: 1.001701196801074, newMultiplierEffectiveTimestamp: 1_789_000_200 };
const NOW = Date.parse("2026-11-21T04:36:00Z");

describe("tvlLeavesOutScaledUi (descriptor flag, no DEX-id branch)", () => {
  it("is set for Meteora only; Raydium, Orca and RHC use their TVL as published", () => {
    expect(tvlLeavesOutScaledUi("meteora-dlmm")).toBe(true);
    for (const protocol of ["raydium-clmm", "orca-whirlpool", "uniswap-v4-rhc", undefined]) expect(tvlLeavesOutScaledUi(protocol)).toBe(false);
  });
});

describe("knownMultiplier", () => {
  it("evaluates a schedule at the given time, gives 1 for a mint read without one, and null when unread", () => {
    expect(knownMultiplier({ known: true, config: NVDAX }, NOW)).toBe(1.001701196801074);
    expect(knownMultiplier({ known: true, config: NVDAX }, Date.parse("2026-09-01T00:00:00Z"))).toBe(1.000918);
    expect(knownMultiplier({ known: true, config: undefined }, NOW)).toBe(1);
    expect(knownMultiplier({ known: false, config: undefined }, NOW)).toBeNull();
    expect(knownMultiplier({ known: false, config: NVDAX }, NOW)).toBeNull();
  });
});

describe("withScaledUiTvl", () => {
  it("adds the multiplier part to a Meteora row and recomputes the fee APR estimate from it", () => {
    const row = withScaledUiTvl(meteora, { a: 1, b: 1.001701196801074 });
    const missing = 218.226743296602 * 0.001701196801074 * 127.61290212453196;
    expect(row.tvlUsd).toBeCloseTo(39_347.15291483027 + missing, 9);
    expect(row.estimatedFeeAprPct).toBeCloseTo(50.87 / row.tvlUsd! * 365 * 100, 9);
    expect(row.tvlScaledUi).toEqual({ status: "corrected", sourceTvlUsd: 39_347.15291483027, mintsRead: true });
  });
  it("is idempotent: a second pass starts from the source's figure", () => {
    const once = withScaledUiTvl(meteora, { a: 1, b: 1.001701196801074 });
    expect(withScaledUiTvl(once, { a: 1, b: 1.001701196801074 })).toEqual(once);
  });
  it("keeps the published TVL when a mint was not read, and records it as unverified", () => {
    const row = withScaledUiTvl(meteora, { a: 1, b: null });
    expect(row.tvlUsd).toBe(39_347.15291483027);
    expect(row.estimatedFeeAprPct).toBeCloseTo(meteora.estimatedFeeAprPct!, 12);
    expect(row.tvlScaledUi).toEqual({ status: "unverified", sourceTvlUsd: 39_347.15291483027, mintsRead: false, reason: "multiplier-unknown" });
  });
  it("leaves Raydium rows (TVL already includes the multiplier) and rows without source inputs untouched", () => {
    const raydium = { ...meteora, protocol: "raydium-clmm" } as RwaPairRow;
    expect(withScaledUiTvl(raydium, { a: 8, b: 8 })).toBe(raydium);
    const bare = { ...meteora, tvlSides: undefined } as RwaPairRow;
    expect(withScaledUiTvl(bare, { a: 1, b: 2 })).toBe(bare);
  });
});

describe("withUsdPerShare (SP-2)", () => {
  // Raydium SNDK/SNDKx (design §0): API TVL already includes the ×8 on both sides.
  const sndk = { poolAddress: "sndk", protocol: "raydium-clmm", tvlUsd: 5556.72, reserveAmounts: { amountA: 5.660742, amountB: 2.8931764 } } as RwaPairRow;

  it("prices a Raydium row in real shares from its TVL, reserves and multipliers", () => {
    expect(withUsdPerShare(sndk, { a: 8, b: 8 }).usdPerShare).toBeCloseTo(81.2, 1);
  });
  it("prices a Meteora row only after its TVL is corrected", () => {
    const corrected = withScaledUiTvl(meteora, { a: 1, b: 1.001701196801074 });
    const priced = withUsdPerShare(corrected, { a: 1, b: 1.001701196801074 });
    // Between datapi's two per-share prices ($127.41 and $127.61): one price for the same stock on both sides.
    expect(priced.usdPerShare).toBeCloseTo(127.4, 1);
    expect(withUsdPerShare(meteora, { a: 1, b: 1.001701196801074 })).not.toHaveProperty("usdPerShare");
  });
  it("drops the price (never guesses) when a multiplier is unknown or the reserves are missing, and is idempotent", () => {
    const priced = withUsdPerShare(sndk, { a: 8, b: 8 });
    expect(withUsdPerShare(priced, { a: 8, b: null })).not.toHaveProperty("usdPerShare");
    expect(withUsdPerShare({ ...sndk, reserveAmounts: undefined } as RwaPairRow, { a: 8, b: 8 })).not.toHaveProperty("usdPerShare");
    expect(withUsdPerShare(priced, { a: 8, b: 8 })).toEqual(priced);
  });
});

describe("withUsdPerShare LST underlying units", () => {
  const solHsol = {
    poolAddress: "sol-hsol",
    protocol: "raydium-clmm",
    tvlUsd: 26_400,
    reserveAmounts: { amountA: 100, amountB: 100 },
  } as RwaPairRow;

  it("prices SOL/hSOL in official SOL units, not 1:1 token amounts", () => {
    const priced = withUsdPerShare(solHsol, { a: 1, b: 1 }, { a: 1, b: 1.2 });
    // 100 SOL + 100 hSOL × 1.2 = 220 SOL; 26400 / 220 = 120 USD per SOL.
    expect(priced.usdPerShare).toBeCloseTo(120, 10);
    expect(withUsdPerShare(solHsol, { a: 1, b: 1 }).usdPerShare).toBeCloseTo(132, 10);
  });

  it("omits usdPerShare when the official rate is missing, rather than falling back to 1:1", () => {
    expect(withUsdPerShare(solHsol, { a: 1, b: 1 }, { a: null, b: null })).not.toHaveProperty("usdPerShare");
  });
});
