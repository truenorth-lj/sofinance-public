import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("InkNav app routes", () => {
  it("points product links at /app and not the landing root", () => {
    const src = readFileSync(resolve("src/components/ink/InkNav.tsx"), "utf8");
    expect(src).toContain("APP_ROUTES.home");
    expect(src).toContain("APP_ROUTES.positionPerformance");
    expect(src).toContain("APP_ROUTES.rwaPairs");
    expect(src).toContain("APP_ROUTES.ai");
    expect(src).not.toContain('href: "/"');
    expect(src).not.toContain('href="/"');
  });
});
