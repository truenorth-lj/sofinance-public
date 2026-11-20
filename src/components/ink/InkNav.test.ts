import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("InkNav wallet slot", () => {
  it("is only the wallet area: no product links, logo, or X link", () => {
    const src = readFileSync(resolve("src/components/ink/InkNav.tsx"), "utf8");
    expect(src).toContain("nav-solana-wallet");
    expect(src).toContain("nav-evm-wallet");
    expect(src).not.toContain("SiteLogo");
    expect(src).not.toContain("BrandMark");
    expect(src).not.toContain("nav-menu");
    expect(src).not.toContain("SOCIAL_LINKS");
    expect(src).not.toContain("BLOG_ROUTES");
    expect(src).not.toContain("DOCS_ROUTES");
    expect(src).not.toContain("GUIDE_ROUTES");
    expect(src).not.toContain('label: "Use AI"');
    expect(src).not.toContain('label: "Blog"');
    expect(src).not.toContain("APP_ROUTES.rwaPairs");
    expect(src).not.toContain("APP_ROUTES.ai");
    expect(src).not.toContain("APP_ROUTES.plan");
    expect(src).not.toContain("next/link");
  });
});

describe("SiteFooter holds Docs and the X link that left the app bar", () => {
  it("keeps Docs, Risks, Terms, X and llms.txt in the shared footer, not the wallet slot", () => {
    const footer = readFileSync(resolve("src/components/site-footer.tsx"), "utf8");
    expect(footer).toContain("DOCS_ROUTES.home");
    expect(footer).toContain("DOCS_ROUTES.risks");
    expect(footer).toContain("LEGAL_ROUTES.terms");
    expect(footer).toContain("SOCIAL_LINKS.x.href");
    expect(footer).toContain("LLMS_TXT_ROUTE");
    expect(footer).toContain("EXTERNAL_LINK_PROPS");
  });
});
