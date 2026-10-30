import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_PAGES } from "./docs-nav";
import { DOCS_ROUTES } from "./public-urls";

describe("docs routes and copy guards", () => {
  it("exposes six public doc pages under /docs", () => {
    expect(DOCS_PAGES).toHaveLength(6);
    expect(DOCS_PAGES.map((page) => page.href)).toEqual([
      DOCS_ROUTES.gettingStarted,
      DOCS_ROUTES.yieldAndApr,
      DOCS_ROUTES.risks,
      DOCS_ROUTES.fees,
      DOCS_ROUTES.withdraw,
      DOCS_ROUTES.security,
    ]);
  });

  it("keeps forbidden marketing claims out of docs copy", () => {
    const roots = [resolve("src/app/docs"), resolve("src/components/docs"), resolve("src/lib/docs-nav.ts")];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|md)$/.test(name)) files.push(path);
      }
    };
    for (const root of roots) {
      if (statSync(root).isDirectory()) walk(root);
      else files.push(root);
    }
    const blob = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(blob).not.toMatch(/open source engine/i);
    expect(blob).not.toMatch(/verify yourself/i);
    expect(blob).not.toMatch(/Turnkey/i);
    expect(blob).not.toMatch(/0-SOL|zero-SOL|zero SOL/i);
    expect(blob).toContain("example transaction");
    expect(blob).toContain("10 basis point");
    expect(blob).toContain("original tokens");
    expect(blob).toContain("two steps");
  });

  it("wires Docs into InkNav and landing", () => {
    const nav = readFileSync(resolve("src/components/ink/InkNav.tsx"), "utf8");
    const landing = readFileSync(resolve("src/components/landing-page.tsx"), "utf8");
    expect(nav).toContain("DOCS_ROUTES.home");
    expect(nav).toContain("BLOG_ROUTES.home");
    expect(landing).toContain("DOCS_ROUTES.home");
    expect(landing).toContain("BLOG_ROUTES.home");
  });

  it("links APR explanations and open confirm to docs pages", () => {
    const picker = readFileSync(resolve("src/components/range-apr/range-preset-picker.tsx"), "utf8");
    const pairs = readFileSync(resolve("src/components/unified-pools/unified-pools-panel.tsx"), "utf8");
    const open = readFileSync(resolve("src/components/open-position-modal.tsx"), "utf8");
    const selected = readFileSync(resolve("src/components/selected-app.tsx"), "utf8");
    expect(picker).toContain("DOCS_ROUTES.yieldAndApr");
    expect(pairs).toContain("DOCS_ROUTES.yieldAndApr");
    expect(open).toContain("DOCS_ROUTES.risks");
    expect(selected).toContain("DOCS_ROUTES.risks");
  });
});
