import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("landing page copy and routes", () => {
  const src = readFileSync(resolve("src/components/landing-page.tsx"), "utf8");

  it("uses the owner hero and three pillars, and does not lead with trading", () => {
    expect(src).toContain("Strategy recipes for AI agents and humans");
    expect(src).toContain("only your wallet can approve them");
    expect(src).toContain("Recipes, not primitives");
    expect(src).toContain("Agent proposes, wallet approves");
    expect(src).toContain("One engine, two surfaces");
    expect(src).not.toMatch(/audited|trustless|risk-free|fully automated|autonomous/i);
    expect(src).not.toMatch(/\btrading\b/i);
  });

  it("uses the inline C3 BrandMark, not the old square logo image", () => {
    expect(src).toContain("BrandMark");
    expect(src).not.toContain("/logo.png");
    expect(src).not.toContain("next/image");
  });

  it("links Launch App and the live RWA Yield scenario into /app", () => {
    expect(src).toContain("APP_ROUTES.home");
    expect(src).toContain("APP_ROUTES.ai");
    expect(src).toContain("APP_ROUTES.rwaPairs");
    expect(src).toContain("RWA Yield");
    expect(src).toContain("Coming soon");
    expect(src).not.toContain("href=\"/rwa-pairs\"");
  });
});
