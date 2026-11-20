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
const labels = (html: string) => [...html.matchAll(/href="[^"]*"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);

describe("SiteHeader", () => {
  it("lists Pools, Portfolio, Learn, AI agents, then Blog on marketing pages; Pools always goes to the list page", () => {
    const marketing = renderToStaticMarkup(createElement(SiteHeader, { variant: "marketing" }));
    const marketingHrefs = hrefs(marketing);
    expect(marketingHrefs).toEqual(expect.arrayContaining(["/", "/app/rwa-pairs", "/app/portfolio", "/learn", "/app/ai", "/blog"]));
    expect(marketingHrefs).not.toContain("#pools");
    expect(marketingHrefs).not.toContain("/#pools");
    const marketingNav = marketing.match(/<nav[\s\S]*?<\/nav>/)![0];
    expect(labels(marketingNav)).toEqual(["Pools", "Portfolio", "Learn", "AI agents", "Blog"]);
    expect(marketing).toContain('data-testid="nav-menu"');
    expect(marketing).toContain("AI agents");
    expect(marketing).not.toContain("Use AI");
    expect(marketing).not.toMatch(/hidden flex-1 sm:flex/);
  });

  it("omits Blog on the app variant and keeps the App nav label", () => {
    const app = renderToStaticMarkup(createElement(SiteHeader, { variant: "app" }));
    expect(hrefs(app)).toEqual(expect.arrayContaining(["/", "/app/rwa-pairs", "/app/portfolio", "/learn", "/app/ai"]));
    expect(hrefs(app)).not.toContain("/blog");
    expect(app).toContain('aria-label="App"');
    expect(app).not.toContain('aria-label="Sections"');
    const appNav = app.match(/<nav[\s\S]*?<\/nav>/)![0];
    expect(labels(appNav)).toEqual(["Pools", "Portfolio", "Learn", "AI agents"]);
    expect(app).not.toContain("Use AI");
    expect(app).not.toContain('data-testid="home-wallet"');
  });

  it("puts Connect wallet on every marketing page and never an Open app button", () => {
    const marketing = renderToStaticMarkup(createElement(SiteHeader, { variant: "marketing" }));
    const app = renderToStaticMarkup(createElement(SiteHeader, { variant: "app" }));
    for (const html of [marketing, app]) {
      expect(html).toMatch(/<a[^>]*href="\/app\/portfolio"[^>]*>Portfolio<\/a>/);
      expect(html).not.toContain("Open app");
    }
    expect(marketing).toMatch(/<button[^>]*data-testid="home-wallet"[^>]*>Connect wallet<\/button>/);
    expect(app).not.toContain('data-testid="home-wallet"');
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
      expect(html, name).toContain('data-testid="site-footer"');
      expect(html, name).toContain('data-testid="home-wallet"');
      expect(html, name).not.toContain('aria-label="App"');
    }
  });

  it("renders a bare cream squircle H mark and wordmark, with no lemon capsule, and the logo always goes home", () => {
    const html = renderToStaticMarkup(createElement(SiteHeader));
    expect(html).toContain('href="/"');
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

  it("keeps the app header on /app/sign/[token] and does not render a footer", () => {
    const sign = readFileSync(resolve("src/app/app/sign/[token]/page.tsx"), "utf8");
    expect(sign).toContain("<SiteHeader variant=\"app\"");
    expect(sign).not.toContain("SiteFooter");
    expect(sign).not.toContain("site-footer");
  });

  it("the homepage and marketing pages render SiteHeader; the app header has no Blog tab", () => {
    expect(readFileSync(resolve("src/components/landing-page.tsx"), "utf8")).toContain('<SiteHeader variant="marketing" />');
    const header = readFileSync(resolve("src/components/site-header.tsx"), "utf8");
    expect(header).toContain('variant === "marketing"');
    expect(header).toContain("BLOG_ROUTES.home");
    expect(header).toContain('label: "AI agents"');
    expect(header).not.toContain('label: "Use AI"');
    expect(header).not.toContain("#pools");
    const nav = readFileSync(resolve("src/components/ink/InkNav.tsx"), "utf8");
    expect(nav).not.toMatch(/label: "Blog"/);
    expect(nav).not.toContain("BLOG_ROUTES");
  });
});
