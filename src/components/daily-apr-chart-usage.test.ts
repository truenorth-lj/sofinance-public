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

  it("shows per-pool daily APR sparklines on the RWA pairs table", () => {
    const src = readFileSync(resolve("src/components/rwa-pairs-panel.tsx"), "utf8");
    expect(src).toContain("PoolAprSparkline");
    expect(src).toContain("Daily APR");
    expect(src).toContain("index < 8");
    expect(src).toMatch(/not Raydium-published daily/);
  });

  it("plans a pool from its daily APR series instead of synthetic sample paths", () => {
    const app = readFileSync(resolve("src/components/plan/plan-app.tsx"), "utf8");
    const chart = readFileSync(resolve("src/components/plan/comparison-chart.tsx"), "utf8");
    const pairs = readFileSync(resolve("src/components/rwa-pairs-panel.tsx"), "utf8");
    expect(app).toContain("usePoolYield");
    expect(app).toContain("buildPlanComparison");
    expect(app).not.toContain("evaluateIntent");
    expect(app).not.toContain("ScenarioCards");
    expect(chart).toContain("Estimate from past average yield, not a forecast");
    expect(pairs).toContain("buildPlanPath");
    expect(pairs).toContain("poolId: pair.poolAddress");
  });

  it("exposes the sparse realized series on get_position_performance MCP output", () => {
    const src = readFileSync(resolve("src/mcp/tools.ts"), "utf8");
    expect(src).toContain("realizedFeeAprSeries: result.realizedFeeAprSeries");
  });
});
