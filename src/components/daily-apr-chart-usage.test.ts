import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("daily APR chart wiring", () => {
  it("mounts the pool daily APR chart on position performance after lookup", () => {
    const src = readFileSync(resolve("src/components/position-performance-panel.tsx"), "utf8");
    expect(src).toContain("PoolDailyAprChart");
    expect(src).toContain("realizedFeeAprSeries");
    expect(src).toContain("poolId={data.poolId}");
  });

  it("shows per-pool daily APR sparklines on the RWA pairs table", () => {
    const src = readFileSync(resolve("src/components/rwa-pairs-panel.tsx"), "utf8");
    expect(src).toContain("PoolAprSparkline");
    expect(src).toContain("Daily APR");
    expect(src).toContain("index < 8");
    expect(src).toMatch(/not Raydium-published daily/);
  });

  it("exposes the sparse realized series on get_position_performance MCP output", () => {
    const src = readFileSync(resolve("src/mcp/tools.ts"), "utf8");
    expect(src).toContain("realizedFeeAprSeries: result.realizedFeeAprSeries");
  });
});
