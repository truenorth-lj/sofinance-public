import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("position-performance page shell", () => {
  it("uses the default 5xl InkShell so InkNav matches Positions / RWA pairs / Use AI", () => {
    const src = readFileSync(resolve("src/app/app/position-performance/page.tsx"), "utf8");
    expect(src).toContain("<InkShell>");
    expect(src).not.toMatch(/maxWidth=["']3xl["']/);
  });

  it("reads ?mint= and ?wallet= from the browser URL, not prerendered page searchParams", () => {
    const page = readFileSync(resolve("src/app/app/position-performance/page.tsx"), "utf8");
    const queryPanel = readFileSync(resolve("src/components/position-performance-query-panel.tsx"), "utf8");
    expect(page).toContain("Suspense");
    expect(page).toContain("PositionPerformanceQueryPanel");
    expect(page).not.toContain("use(searchParams)");
    expect(page).not.toMatch(/searchParams:\s*Promise/);
    expect(queryPanel).toContain("useSearchParams");
    expect(queryPanel).toContain("queryFromSearchParams");
    expect(queryPanel).toContain("initialMint={query.mint}");
    expect(queryPanel).toContain("initialWallet={query.wallet}");
  });
});
