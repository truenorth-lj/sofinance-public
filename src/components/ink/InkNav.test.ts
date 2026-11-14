import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("InkNav app routes", () => {
  it("uses the shared cream SiteLogo, not the lemon BrandMark pill or the old square logo image", () => {
    const src = readFileSync(resolve("src/components/ink/InkNav.tsx"), "utf8");
    expect(src).toContain("SiteLogo");
    expect(src).toContain("APP_ROUTES.home");
    expect(src).not.toContain("BrandMark");
    expect(src).not.toContain("bg-lemon");
    expect(src).not.toContain("/logo.png");
    expect(src).not.toContain("next/image");
  });

  it("points product links at /app and not the landing root", () => {
    const src = readFileSync(resolve("src/components/ink/InkNav.tsx"), "utf8");
    expect(src).toContain("APP_ROUTES.home");
    expect(src).not.toContain("APP_ROUTES.positionPerformance");
    expect(src).toContain("APP_ROUTES.rwaPairs");
    expect(src).toContain("APP_ROUTES.ai");
    // 11/4: Blog moved to the marketing header (SiteHeader); the app bar has no Blog tab.
    expect(src).not.toContain("BLOG_ROUTES");
    expect(src).not.toContain('label: "Blog"');
    // Plan and Docs left the top bar on 11/4; Docs lives in the app footer.
    expect(src).not.toContain("APP_ROUTES.plan");
    expect(src).not.toContain("DOCS_ROUTES.home");
    expect(readFileSync(resolve("src/components/ink/InkFooter.tsx"), "utf8")).toContain("DOCS_ROUTES.home");
    expect(src).not.toContain('href: "/"');
    expect(src).not.toContain('href="/"');
  });
});

describe("InkNav social link", () => {
  it("links the official X account via the shared SOCIAL_LINKS config", () => {
    const src = readFileSync(resolve("src/components/ink/InkNav.tsx"), "utf8");
    expect(src).toContain("SOCIAL_LINKS.x.href");
    expect(src).toContain("EXTERNAL_LINK_PROPS");
  });
});
