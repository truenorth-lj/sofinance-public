import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/terms" }));

import { SITE_REGION_LINE, SITE_TAGLINE, SiteFooter } from "./site-footer";
import TermsPage from "@/app/terms/page";

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("SiteFooter", () => {
  it("uses the shared tagline and region line, and never the old Raydium CLMM tool line", () => {
    expect(SITE_TAGLINE).toBe("Self-custodial liquidity on Solana and Robinhood Chain");
    expect(SITE_REGION_LINE).toBe("Not available to US persons or restricted regions.");
    const html = renderToStaticMarkup(createElement(SiteFooter, { variant: "marketing" }));
    expect(html).toContain(`SoFinance · ${SITE_TAGLINE}`);
    expect(html).toContain(SITE_REGION_LINE);
    expect(html).not.toContain("Raydium CLMM tool");
    expect(html).toContain("llms.txt");
  });

  it("groups Product, Learn and Legal, and shows Blog only on marketing pages", () => {
    const marketing = renderToStaticMarkup(createElement(SiteFooter, { variant: "marketing" }));
    const app = renderToStaticMarkup(createElement(SiteFooter, { variant: "app" }));
    expect(marketing).toContain('aria-label="Product"');
    expect(marketing).toContain('aria-label="Learn"');
    expect(marketing).toContain('aria-label="Legal"');
    expect(hrefs(marketing)).toEqual(expect.arrayContaining([
      "/pools", "/app/portfolio", "/app/ai",
      "/learn", "/docs", "/faq", "/fees", "/blog",
      "/docs/risks", "/terms", "/llms.txt",
    ]));
    expect(marketing).toMatch(/<a[^>]*href="\/terms"[^>]*>Terms<\/a>/);
    expect(marketing).not.toContain("Terms of Service");
    expect(hrefs(app)).toEqual(expect.arrayContaining([
      "/pools", "/app/portfolio", "/app/ai",
      "/learn", "/docs", "/faq", "/fees",
      "/docs/risks", "/terms", "/llms.txt",
    ]));
    expect(hrefs(app)).not.toContain("/blog");
    expect(app).not.toContain("Blog");
  });

  it("is rendered on the terms page", () => {
    const html = renderToStaticMarkup(createElement(TermsPage));
    expect(html).toContain('data-testid="site-footer"');
    expect(html).toContain(SITE_TAGLINE);
  });
});
