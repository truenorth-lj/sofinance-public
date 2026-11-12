import { describe, expect, it } from "vitest";
import { exactAprTitle, formatApproxAprPct, formatAprPct2dp, formatChartAprPct } from "./apr";
import { formatPct2dp, formatArrowChangePct, formatSignedChangePct } from "./pct";
import { formatCompactUsd, formatPoolUsd, formatStockPrice, formatUsd, formatUsd4dp } from "./usd";
import { MISSING } from "./helpers";

describe("formatAprPct2dp", () => {
  it("shows missing data as — (never 0.00%)", () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatAprPct2dp(value)).toBe(MISSING);
  });
  it("shows a tiny real APR as <0.01% instead of rounding it to 0.00%", () => {
    expect(formatAprPct2dp(0.0005575645952321763)).toBe("<0.01%");
    expect(formatAprPct2dp(0.0049)).toBe("<0.01%");
    expect(exactAprTitle(0.0005575645952321763)).toBe("≈0.00056%");
  });
  it("keeps two decimals otherwise", () => {
    expect(formatAprPct2dp(0.005)).toBe("0.01%");
    expect(formatAprPct2dp(7.5)).toBe("7.50%");
    expect(formatAprPct2dp(0)).toBe("0.00%");
    expect(exactAprTitle(7.5)).toBeUndefined();
  });
});

describe("formatApproxAprPct", () => {
  it("uses one decimal below 10%, none above, and caps huge values", () => {
    expect(formatApproxAprPct(7.66)).toBe("~7.7%");
    expect(formatApproxAprPct(154.06)).toBe("~154%");
    expect(formatApproxAprPct(9.96)).toBe("~10.0%");
    expect(formatApproxAprPct(999.4)).toBe("~999%");
    expect(formatApproxAprPct(1000)).toBe("1,000%+");
    expect(formatApproxAprPct(52_000)).toBe("1,000%+");
  });
  it("shows ~0% for tiny values and a dash for invalid ones", () => {
    expect(formatApproxAprPct(0)).toBe("~0%");
    expect(formatApproxAprPct(0.04)).toBe("~0%");
    expect(formatApproxAprPct(Number.NaN)).toBe(MISSING);
    expect(formatApproxAprPct(-1)).toBe(MISSING);
  });
  it("drops the ~ when asked, keeping the same rounding", () => {
    expect(formatApproxAprPct(7.66, false)).toBe("7.7%");
    expect(formatApproxAprPct(154.06, false)).toBe("154%");
    expect(formatApproxAprPct(0.04, false)).toBe("0%");
    expect(formatApproxAprPct(1000, false)).toBe("1,000%+");
    expect(formatApproxAprPct(Number.NaN, false)).toBe(MISSING);
  });
});

describe("formatChartAprPct", () => {
  it("uses two decimals below 100 and one decimal at 100 and above", () => {
    expect(formatChartAprPct(7.5)).toBe("7.50%");
    expect(formatChartAprPct(99.994)).toBe("99.99%");
    expect(formatChartAprPct(100)).toBe("100.0%");
    expect(formatChartAprPct(154.06)).toBe("154.1%");
    expect(formatChartAprPct(-3.2)).toBe("-3.20%");
  });
});

describe("formatUsd", () => {
  it("formats USD with a real minus sign, a plus only when asked, and no negative zero", () => {
    expect(formatUsd(1752.844)).toBe("$1,752.84");
    expect(formatUsd(-27.125)).toBe("−$27.13");
    expect(formatUsd(18.37, { signed: true })).toBe("+$18.37");
    expect(formatUsd(5.5)).toBe("$5.50");
    expect(formatUsd(-0.004, { signed: true })).toBe("$0.00");
    expect(formatUsd(null)).toBe(MISSING);
  });
});

describe("formatStockPrice / formatCompactUsd", () => {
  it("picks decimal places from the price magnitude", () => {
    expect(formatStockPrice(187.5)).toBe("$187.50");
    expect(formatStockPrice(1)).toBe("$1.00");
    expect(formatStockPrice(0.99)).toBe("$0.9900");
    expect(formatStockPrice(0.00987654)).toBe("$0.009877");
    expect(formatStockPrice(Number.NaN)).toBe(MISSING);
  });
  it("compacts large USD figures with a one-decimal suffix", () => {
    expect(formatCompactUsd(1.54e12)).toBe("$1.5T");
    expect(formatCompactUsd(2.3e9)).toBe("$2.3B");
    expect(formatCompactUsd(4.56e6)).toBe("$4.6M");
    expect(formatCompactUsd(1500)).toBe("$1.5k");
    expect(formatCompactUsd(500)).toBe("$500");
    expect(formatCompactUsd(Number.NaN)).toBe(MISSING);
  });
});

describe("formatPoolUsd / formatUsd4dp", () => {
  it("keeps the pool-list compact rules (2dp millions, 1dp thousands, 2dp otherwise)", () => {
    expect(formatPoolUsd(1_500_000)).toBe("$1.50M");
    expect(formatPoolUsd(1500)).toBe("$1.5k");
    expect(formatPoolUsd(12.3)).toBe("$12.30");
    expect(formatPoolUsd(null)).toBe(MISSING);
    expect(formatPoolUsd(Number.NaN)).toBe(MISSING);
  });
  it("keeps four decimals on performance USD figures", () => {
    expect(formatUsd4dp(12.34567)).toBe("$12.3457");
    expect(formatUsd4dp(0)).toBe("$0.0000");
    expect(formatUsd4dp(null)).toBe(MISSING);
  });
});

describe("formatSignedChangePct / formatArrowChangePct / formatPct2dp", () => {
  it("signs a stock-card change with + / −", () => {
    expect(formatSignedChangePct(3.86)).toBe("+3.86%");
    expect(formatSignedChangePct(-5.8)).toBe("−5.80%");
    expect(formatSignedChangePct(0)).toBe("0.00%");
    expect(formatSignedChangePct(Number.NaN)).toBe(MISSING);
  });
  it("formats a performance change with its arrow", () => {
    expect(formatArrowChangePct(-6.0769)).toBe("↓ 6.08%");
    expect(formatArrowChangePct(3.86)).toBe("↑ 3.86%");
    expect(formatArrowChangePct(undefined)).toBe(MISSING);
  });
  it("formats a two-decimal percent without the tiny-APR substitution", () => {
    expect(formatPct2dp(7.5)).toBe("7.50%");
    expect(formatPct2dp(0.0005)).toBe("0.00%");
    expect(formatPct2dp(null)).toBe(MISSING);
  });
});

describe("missing glyph", () => {
  it("is the em-dash, never an en-dash", () => {
    expect(MISSING).toBe("—");
    expect(MISSING).not.toBe("–");
  });
});
