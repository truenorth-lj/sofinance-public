import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("shared PositionSelect usage", () => {
  it("uses the unified All positions entry while preserving manual public performance lookup", () => {
    const app = readFileSync(resolve("src/components/selected-app.tsx"), "utf8");
    const stocks = readFileSync(resolve("src/components/stocks-section.tsx"), "utf8");
    const perf = readFileSync(resolve("src/components/position-performance-panel.tsx"), "utf8");
    // The one dropdown left is the Compound fees tab's (it has no All positions card).
    expect(app.match(/<GroupedPositionSelect/g)).toHaveLength(1);
    expect(app).toContain('id="compound-position"');
    expect(app).toContain("all-positions-heading");
    expect(stocks).toContain("<StocksOverview embedded");
    expect(app).toContain("position-fallback-select");
    expect(perf).toContain("<PositionSelect");
    expect(perf).toContain("Position NFT mint (base58)");
    expect(app).not.toContain("ticks {item.tickLower}");
    expect(perf).not.toContain("ticks {item.tickLower}");
  });
});
