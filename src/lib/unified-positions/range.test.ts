import { describe, expect, it } from "vitest";
import { formatTickPriceRange, isUsdStable, priceAtTick, significant } from "./range";

const t = (symbol: string, decimals = 18) => ({ symbol, decimals });

describe("formatTickPriceRange (PM Q3: price, not ticks)", () => {
  it("stable pair (SPCX/SPCXon): token1 per token0, 5 significant digits", () => {
    const r = formatTickPriceRange({ tickLower: -10, tickUpper: 10, token0: t("SPCX"), token1: t("SPCXon"), stablePair: true })!;
    expect(r).toMatchObject({ lower: "0.999", upper: "1.001", base: "SPCX", quote: "SPCXon" });
    expect(r.text).toBe("0.999–1.001 SPCXon per SPCX");
    const wide = formatTickPriceRange({ tickLower: -123, tickUpper: 77, token0: t("SPCX"), token1: t("SPCXon"), stablePair: true })!;
    expect(wide.lower).toBe("0.98778"); // 5 digits
    expect(wide.upper).toBe("1.0077");
  });

  it("quotes in the USD side: inverts when only token0 is a USD stable; 4 significant digits for a non-stable pair", () => {
    // token0 USDC (6), token1 WETH (18): raw token1/token0 is tiny; inverted it reads USDC per WETH.
    const r = formatTickPriceRange({ tickLower: 196_000, tickUpper: 197_000, token0: t("USDC", 6), token1: t("WETH") })!;
    expect(r.base).toBe("WETH");
    expect(r.quote).toBe("USDC");
    expect(Number(r.lower)).toBeLessThan(Number(r.upper));
    expect(r.lower.replace(".", "").replace(/^0+/, "").length).toBeLessThanOrEqual(4);
    expect(r.text).toBe(`${r.lower}–${r.upper} USDC per WETH`);
  });

  it("does not invert when token1 is the USD side", () => {
    const r = formatTickPriceRange({ tickLower: 0, tickUpper: 100, token0: t("WETH"), token1: t("USDC") })!;
    expect([r.base, r.quote]).toEqual(["WETH", "USDC"]);
  });

  it("both sides USD stables: token1 per token0 with 5 digits", () => {
    const r = formatTickPriceRange({ tickLower: -5, tickUpper: 5, token0: t("USDC", 6), token1: t("USDT", 6) })!;
    expect([r.base, r.quote, r.lower, r.upper]).toEqual(["USDC", "USDT", "0.9995", "1.0005"]);
  });

  it("rejects non-integer ticks", () => {
    expect(formatTickPriceRange({ tickLower: 0.5, tickUpper: 1, token0: t("A"), token1: t("B") })).toBeNull();
  });

  it("helpers", () => {
    expect(isUsdStable(" usdc ")).toBe(true);
    expect(isUsdStable("SPCX")).toBe(false);
    expect(priceAtTick(0, 18, 18)).toBe(1);
    expect(significant(1234.5678, 4)).toBe("1235");
    expect(significant(0, 4)).toBe("—");
  });
});
