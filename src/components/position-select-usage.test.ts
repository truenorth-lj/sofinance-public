import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("shared PositionSelect usage", () => {
  it("uses the unified All positions entry; no NFT-mint lookup on /app", () => {
    const app = readFileSync(resolve("src/components/selected-app.tsx"), "utf8");
    const stocks = readFileSync(resolve("src/components/stocks-section.tsx"), "utf8");
    const perf = readFileSync(resolve("src/components/position-performance-panel.tsx"), "utf8");
    // All positions is the only picker: the Compound fees tab no longer carries its own dropdown.
    expect(app).not.toContain("GroupedPositionSelect");
    expect(app).not.toContain('id="compound-position"');
    expect(app).toContain("all-positions-heading");
    expect(stocks).toContain("<StocksOverview embedded");
    expect(readFileSync(resolve("src/components/portfolio/portfolio-rows.tsx"), "utf8")).toContain("position-fallback-select");
    expect(perf).toContain("<PositionSelect");
    expect(perf).not.toContain("Look up another position by NFT mint");
    expect(app).not.toContain("ticks {item.tickLower}");
    expect(perf).not.toContain("ticks {item.tickLower}");
  });
});
