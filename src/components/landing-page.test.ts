import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("landing page copy and routes", () => {
  const src = readFileSync(resolve("src/components/landing-page.tsx"), "utf8");

  it("positions SoFinance as a self-custodial tool, not a yield product", () => {
    expect(src).toContain("A self-custodial tool to manage your Raydium CLMM positions");
    expect(src).toContain("Open a position with one signature");
    expect(src).toContain("compound fees in one click");
    expect(src).toContain("exit in one click");
    expect(src).toContain("You sign every transaction yourself");
    expect(src).toContain("directly on Raydium");
    expect(src).toContain("Tested position actions");
    expect(src).toContain("Agent proposes, wallet approves");
    expect(src).toContain("One engine, two surfaces");
    expect(src).not.toMatch(/audited|trustless|risk-free|fully automated|autonomous/i);
    expect(src).not.toMatch(/\btrading\b/i);
  });

  it("has no yield or strategy headlines", () => {
    expect(src).not.toMatch(/\byield\b|\bearn\b|make your money|strateg|recipe/i);
    for (const file of ["src/app/page.tsx", "src/app/layout.tsx", "src/app/manifest.ts"]) {
      expect(readFileSync(resolve(file), "utf8"), file).not.toMatch(/\byield\b|\bearn\b|make your money|strateg|recipe/i);
    }
  });

  it("does not claim to be open source", () => {
    expect(src).not.toMatch(/open[- ]source|\bMIT\b/i);
  });

  it("uses the inline C3 BrandMark, not the old square logo image", () => {
    expect(src).toContain("BrandMark");
    expect(src).not.toContain("/logo.png");
    expect(src).not.toContain("next/image");
  });

  it("links Launch App and the live RWA CLMM positions card into /app", () => {
    expect(src).toContain("APP_ROUTES.home");
    expect(src).toContain("APP_ROUTES.ai");
    expect(src).toContain("DOCS_ROUTES.home");
    expect(src).toContain("APP_ROUTES.rwaPairs");
    expect(src).toContain("RWA CLMM positions");
    expect(src).toContain("Coming soon");
    expect(src).not.toContain("href=\"/rwa-pairs\"");
  });
});
