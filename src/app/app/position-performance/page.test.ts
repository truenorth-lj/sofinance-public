import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("position-performance page shell", () => {
  it("uses the default 5xl InkShell so InkNav matches Positions / RWA pairs / Use AI", () => {
    const src = readFileSync(resolve("src/app/app/position-performance/page.tsx"), "utf8");
    expect(src).toContain("<InkShell>");
    expect(src).not.toMatch(/maxWidth=["']3xl["']/);
  });

  it("forwards ?mint= and ?wallet= into the lookup form", () => {
    const src = readFileSync(resolve("src/app/app/position-performance/page.tsx"), "utf8");
    expect(src).toContain("searchParams");
    expect(src).toContain("parsePerformanceQuery");
    expect(src).toContain("initialMint={query.mint}");
    expect(src).toContain("initialWallet={query.wallet}");
    expect(src).toContain("key={`${query.mint}:${query.wallet}`}");
  });
});
