import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/docs" }));

import { SiteHeader } from "./site-header";
import { BlogShell } from "./blog/blog-shell";
import { DocsShell } from "./docs/docs-shell";
import FaqPage from "@/app/faq/page";
import TermsPage from "@/app/terms/page";
import NotFound from "@/app/not-found";

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("SiteHeader", () => {
  it("links Pools to the homepage list (in-page on the homepage) and AI agents to the app's agent page", () => {
    const home = hrefs(renderToStaticMarkup(createElement(SiteHeader, { onHomepage: true })));
    expect(home).toEqual(expect.arrayContaining(["/", "#pools", "/app/ai", "/blog", "/app/portfolio"]));
    const other = hrefs(renderToStaticMarkup(createElement(SiteHeader)));
    expect(other).toEqual(expect.arrayContaining(["/", "/#pools", "/app/ai", "/blog", "/app/portfolio"]));
    expect(other).not.toContain("#pools");
    // The homepage has no agents section any more.
    expect([...home, ...other].some((href) => href?.endsWith("#agents"))).toBe(false);
  });

  it("has Portfolio in the nav and no Open app; only the homepage has the wallet button (it connects in place)", () => {
    const home = renderToStaticMarkup(createElement(SiteHeader, { onHomepage: true }));
    const other = renderToStaticMarkup(createElement(SiteHeader));
    for (const html of [home, other]) {
      expect(html).toMatch(/<a[^>]*href="\/app\/portfolio"[^>]*>Portfolio<\/a>/);
      expect(html).not.toContain("Open app");
    }
    expect(home).toMatch(/<button[^>]*data-testid="home-wallet"[^>]*>Connect wallet<\/button>/);
    expect(other).not.toContain('data-testid="home-wallet"');
  });

  it("is the header on the blog, docs, FAQ, terms and 404 pages, not the app bar", () => {
    const pages = {
      blog: createElement(BlogShell, null, "x"),
      docs: createElement(DocsShell, null, "x"),
      faq: createElement(FaqPage),
      terms: createElement(TermsPage),
      notFound: createElement(NotFound),
    };
    for (const [name, el] of Object.entries(pages)) {
      const html = renderToStaticMarkup(el);
      expect(html, name).toContain('data-testid="site-header"');
      expect(html, name).not.toContain('aria-label="App"');
    }
  });

  it("renders a bare cream squircle H mark and wordmark, with no lemon capsule", () => {
    const html = renderToStaticMarkup(createElement(SiteHeader));
    expect(html).toContain('src="/navbar-mark-squircle-cream.svg"');
    expect(html).toContain('width="36"');
    expect(html).toContain('height="36"');
    expect(html).toContain("h-9 w-9 max-w-none shrink-0 object-contain");
    expect(html).toContain("flex h-9 w-9 shrink-0 items-center justify-center overflow-visible");
    expect(html).toContain("flex shrink-0 items-center gap-2.5");
    expect(html).toContain("gap-2.5");
    expect(html).toContain("font-display");
    expect(html).toContain("text-[20px]");
    expect(html).toContain("font-bold");
    expect(html).toContain("text-cream");
    expect(html).toContain("SoFinance");
    expect(html).not.toContain("bg-lemon");
    expect(html).not.toContain("pl-[7px]");
    expect(html).not.toContain("text-lemon");
    expect(html).not.toContain('preserveAspectRatio="none"');
  });

  it("the navbar mark SVG has a viewBox and does not stretch with preserveAspectRatio=none", () => {
    const svg = readFileSync(resolve("public/navbar-mark-squircle-cream.svg"), "utf8");
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
    expect(svg).not.toContain('preserveAspectRatio="none"');
  });

  it("the homepage renders SiteHeader and the app bar has no Blog tab", () => {
    expect(readFileSync(resolve("src/components/landing-page.tsx"), "utf8")).toContain("<SiteHeader onHomepage />");
    const nav = readFileSync(resolve("src/components/ink/InkNav.tsx"), "utf8");
    expect(nav).not.toMatch(/label: "Blog"/);
  });
});
