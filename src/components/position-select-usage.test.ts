import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("shared PositionSelect usage", () => {
  it("replaces both LP pickers and keeps manual mint paste on performance", () => {
    const app = readFileSync(resolve("src/components/selected-app.tsx"), "utf8");
    const perf = readFileSync(resolve("src/components/position-performance-panel.tsx"), "utf8");
    expect(app).toContain("<PositionSelect");
    expect(perf).toContain("<PositionSelect");
    expect(perf).toContain("Position NFT mint (base58)");
    expect(app).not.toContain("ticks {item.tickLower}");
    expect(perf).not.toContain("ticks {item.tickLower}");
  });
});
