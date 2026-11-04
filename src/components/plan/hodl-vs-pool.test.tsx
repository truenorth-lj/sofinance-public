import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildPlanComparison, planEntryCost } from "@/lib/lp-plan-yield";
import { HodlVsPool } from "./hodl-vs-pool";

function plan(days: number, aprPct = "36.5") {
  return buildPlanComparison({ capital: "1000", days, aprPct, sampleDays: 29, aprWindowDays: 90, entryCost: planEntryCost("1000") });
}

const markup = (props: Parameters<typeof HodlVsPool>[0]) => renderToStaticMarkup(createElement(HodlVsPool, props));
const text = (props: Parameters<typeof HodlVsPool>[0]) => markup(props).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("HodlVsPool", () => {
  it("shows holding, holding plus earned shares, the difference and break-even as stat tiles", () => {
    // 36.5% APR → 0.1%/day: 1,000 × 1.001^365 = 1,440.25; minus the $10 opening cost → +$430.25.
    const out = text({ comparison: plan(365), holdLabel: "SPCX", poolLabel: "SPCXx/SPCX", shareSymbol: "SPCX" });
    expect(out).toContain("HODL vs. HODL + more shares");
    expect(out).toContain("Collect more SPCX while you hold SPCX · $1,000 for 365 days");
    expect(out).toContain("HODL $1,000.00 SPCX · $0.00 (0%)");
    expect(out).toContain("HODL + more shares $1,430.25 SPCXx/SPCX · +$430.25 (+43.03%)");
    expect(out).toContain("Difference +$430.25 +43.03% vs HODL");
    expect(out).toContain("Break-even Day 10");
  });

  it("uses quiet sentence-case labels, not the old poster cards", () => {
    const html = markup({ comparison: plan(365), holdLabel: "SPCX", poolLabel: "SPCXx/SPCX", shareSymbol: "SPCX" });
    expect(html).not.toMatch(/stays 100|100 →|entry fee|A · |B · |Pool \(LP\)|bg-lemon p-5|uppercase/);
    expect(html).toContain("text-mint");
  });

  it("shows a loss in coral, with no break-even inside a short period", () => {
    const html = markup({ comparison: plan(5), holdLabel: "SPCX", poolLabel: "SPCXx/SPCX" });
    expect(html).toContain("text-coral");
    expect(html.replace(/<[^>]+>/g, " ")).toContain("Not in this period");
  });

  it("speaks of fees, not shares, for a pool with no stock", () => {
    const out = text({ comparison: plan(30), holdLabel: "USDC + USDT", poolLabel: "USDC/USDT" });
    expect(out).toContain("HODL vs. HODL + fees");
    expect(out).toContain("Collect swap fees while you hold USDC + USDT");
    expect(out).not.toContain("more shares");
  });
});
