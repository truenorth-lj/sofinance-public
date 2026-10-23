import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HIGHEST_RANGE_APR_7D_HELP,
  HOMEPAGE_APR_DOCS_LINK_LABEL,
  HOMEPAGE_POOL_APR_LABEL,
} from "@/lib/apr-labels/copy";

describe("landing page copy and routes", () => {
  const src = readFileSync(resolve("src/components/landing-page.tsx"), "utf8");
  const table = readFileSync(resolve("src/components/homepage-pools-table.tsx"), "utf8");
  const copyFiles = [
    "src/components/landing-page.tsx",
    "src/components/homepage-pools-table.tsx",
    "src/lib/homepage-pools.ts",
    "src/app/page.tsx",
    "src/app/layout.tsx",
    "src/app/manifest.ts",
  ];

  it("leads with tokenized-stock LP in one signature, not a yield product", () => {
    expect(src).toContain("LP tokenized stocks on Raydium — in one signature.");
    expect(src).toContain("Pick an xStock pool, set your range, and open the position with a single wallet signature.");
    expect(src).toContain("Compound fees or exit in one click.");
    expect(src).toContain("You sign every transaction");
    expect(src).toContain("normal Raydium position");
    expect(src).toContain("Browse pools");
    expect(src).toContain("Already have a position? Manage it");
    expect(src).toMatch(/non-custodial/i);
    expect(src).toContain("verifiable on Solscan");
    expect(src).not.toMatch(/audited|trustless|risk-free|fully automated|autonomous/i);
    expect(src).not.toMatch(/\btrading\b/i);
  });

  it("has no yield or strategy headlines", () => {
    for (const file of copyFiles) {
      expect(readFileSync(resolve(file), "utf8"), file).not.toMatch(
        /\byield\b|\bearn\b|make your money|strateg|recipe/i,
      );
    }
  });

  it("does not claim to be open source", () => {
    expect(src).not.toMatch(/open[- ]source|\bMIT\b/i);
    expect(table).not.toMatch(/open[- ]source|\bMIT\b/i);
  });

  it("does not mention the prototype app, Turnkey, or a fee wallet", () => {
    for (const file of copyFiles) {
      expect(readFileSync(resolve(file), "utf8"), file).not.toMatch(/Turnkey|prototype app|fee wallet/i);
    }
  });

  it("uses the inline C3 BrandMark, not the old square logo image", () => {
    expect(src).toContain("BrandMark");
    expect(src).not.toContain("/logo.png");
    expect(src).not.toContain("next/image");
  });

  it("keeps /app reachable and deep-links Open position into the existing flow", () => {
    expect(src).toContain("APP_ROUTES.home");
    expect(src).toContain("APP_ROUTES.ai");
    expect(src).toContain("DOCS_ROUTES.home");
    expect(src).toContain("DOCS_ROUTES.risks");
    expect(src).toContain("BLOG_ROUTES.home");
    expect(src).toContain("HomepagePoolsTable");
    expect(table).toContain("APP_ROUTES.rwaPairs");
    expect(table).toContain("buildOpenPositionPath");
    expect(table).toContain("Open position");
    expect(table).toContain("fetchRwaPairsList");
    expect(src).not.toContain('href="/rwa-pairs"');
  });

  it("replaces the four-step technical flow with three user steps and drops engine jargon", () => {
    expect(src).toContain("Pick a pool and range");
    expect(src).toContain("Review the preview");
    expect(src).toContain("Sign once");
    expect(src).not.toContain("The problem");
    expect(src).not.toContain("Three pillars");
    expect(src).not.toContain("Coming soon");
    expect(src).not.toMatch(/HMAC|v0 tx|signUrl|permit/i);
    expect(table).not.toMatch(/HMAC|v0 tx|signUrl|permit/i);
  });

  it("labels homepage APR with the cards' Est. highest range APR / not guaranteed copy", () => {
    expect(HOMEPAGE_POOL_APR_LABEL).toBe("Est. highest range APR · 7d avg · not guaranteed");
    expect(HOMEPAGE_APR_DOCS_LINK_LABEL).toBe("APR details");
    expect(`${HOMEPAGE_POOL_APR_LABEL} ${HIGHEST_RANGE_APR_7D_HELP} ${HOMEPAGE_APR_DOCS_LINK_LABEL}`).not.toMatch(
      /\byield\b|\bearn\b|make your money|strateg|recipe|open[- ]source|\bMIT\b/i,
    );
    expect(table).toContain("HOMEPAGE_POOL_APR_LABEL");
    expect(table).toContain("HIGHEST_RANGE_APR_7D_HELP");
    expect(table).toContain("DOCS_ROUTES.yieldAndApr");
    expect(table).toContain("usePoolRangeApr");
    expect(table).not.toContain("POOL_FEE_APR_24H_HELP");
  });
});
