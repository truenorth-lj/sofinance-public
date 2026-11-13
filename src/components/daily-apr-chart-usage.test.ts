import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("daily APR chart wiring", () => {
  it("mounts the pool daily APR chart on position performance after lookup", () => {
    const src = readFileSync(resolve("src/components/position-performance-panel.tsx"), "utf8");
    const summary = readFileSync(resolve("src/components/position-performance-summary.tsx"), "utf8");
    expect(summary).toContain("PoolDailyAprChart");
    expect(summary).toContain("realizedFeeAprSeries");
    expect(src).toContain("PerformancePoolChart");
    expect(src).toContain("previewPoolId");
    expect(src).toContain("data?.poolId || previewPoolId");
  });

  it("keeps daily APR off the RWA pair cards (no per-card sparkline requests)", () => {
    for (const file of [
      "src/components/unified-pools/unified-pools-panel.tsx",
      "src/components/unified-pools/pool-card.tsx",
    ]) {
      const src = readFileSync(resolve(file), "utf8");
      expect(src, file).not.toContain("PoolAprSparkline");
      expect(src, file).not.toContain("Daily APR");
    }
  });

  it("plans a pool from its daily APR series instead of synthetic sample paths", () => {
    const app = readFileSync(resolve("src/components/plan/plan-app.tsx"), "utf8");
    const chart = readFileSync(resolve("src/components/plan/comparison-chart.tsx"), "utf8");
    const pairs = readFileSync(resolve("src/components/unified-pools/unified-pools-panel.tsx"), "utf8");
    expect(app).toContain("usePoolYield");
    expect(app).toContain("projectPoolPlan");
    expect(app).not.toContain("evaluateIntent");
    expect(app).not.toContain("ScenarioCards");
    expect(chart).toContain("Best case from past fee data, not a forecast");
    // The pool cards plan through the share calculator dialog, which reads the same series and links the full plan.
    const calc = readFileSync(resolve("src/components/unified-pools/share-calc-dialog.tsx"), "utf8");
    expect(pairs).toContain("ShareCalcDialog");
    expect(calc).toContain("usePoolYield(pool.poolAddress)");
    expect(calc).toContain("projectPoolPlan");
    // Both project through the pool terms, which build the comparison from the daily series' best window.
    const terms = readFileSync(resolve("src/lib/lp-plan-pool-terms.ts"), "utf8");
    expect(terms).toContain("buildPlanComparison");
    // With the Plan page off (it redirects to the pools list), the dialog is the only planner and links nowhere else.
    expect(calc).not.toContain("buildPlanPath");
    const planRoute = readFileSync(resolve("src/app/app/plan/page.tsx"), "utf8");
    expect(planRoute).toContain("redirect(APP_ROUTES.rwaPairs)");
  });

  it("exposes the sparse realized series on get_position_performance MCP output", () => {
    const src = readFileSync(resolve("src/mcp/tools/positions.ts"), "utf8");
    expect(src).toContain("realizedFeeAprSeries: result.realizedFeeAprSeries");
  });
});
