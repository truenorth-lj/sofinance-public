import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("daily APR chart wiring", () => {
  it("mounts the pool daily APR chart on position performance after lookup", () => {
    const src = readFileSync(resolve("src/components/position-performance-panel.tsx"), "utf8");
    expect(src).toContain("PoolDailyAprChart");
    expect(src).toContain("realizedFeeAprSeries");
    expect(src).toContain("previewPoolId");
    expect(src).toContain("data?.poolId || previewPoolId");
  });

  it("keeps daily APR off the /app pool cards (no per-card sparkline requests)", () => {
    const src = readFileSync(resolve("src/components/unified-pools/unified-pools-panel.tsx"), "utf8");
    expect(src).not.toContain("PoolAprSparkline");
    expect(src).not.toContain("Daily APR");
  });

  it("plans a pool from its daily APR series instead of synthetic sample paths", () => {
    const app = readFileSync(resolve("src/components/plan/plan-app.tsx"), "utf8");
    const chart = readFileSync(resolve("src/components/plan/comparison-chart.tsx"), "utf8");
    expect(app).toContain("usePoolYield");
    expect(app).toContain("buildPlanComparison");
    expect(app).not.toContain("evaluateIntent");
    expect(app).not.toContain("ScenarioCards");
    expect(chart).toContain("Best case from past yield, not a forecast");
  });

  it("exposes the sparse realized series on get_position_performance MCP output", () => {
    const src = readFileSync(resolve("src/mcp/tools.ts"), "utf8");
    expect(src).toContain("realizedFeeAprSeries: result.realizedFeeAprSeries");
  });
});
