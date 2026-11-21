import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/docs" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import { SiteHeader } from "./site-header";
import { BlogShell } from "./blog/blog-shell";
import { DocsShell } from "./docs/docs-shell";
import { PublicPoolPage } from "./public-pool-page";
import { publicPoolPageModel } from "@/lib/public-pool-pages";
import type { HomepagePool } from "@/lib/homepage-pools";
import FaqPage from "@/app/faq/page";
import TermsPage from "@/app/terms/page";
import NotFound from "@/app/not-found";
import LearnPage from "@/app/learn/page";

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const labels = (html: string) => [...html.matchAll(/href="[^"]*"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);

function header(pathname: string): string {
  nav.pathname = pathname;
  return renderToStaticMarkup(createElement(SiteHeader));
}

function appNav(html: string): string {
  const match = html.match(/<nav[^>]*aria-label="App"[\s\S]*?<\/nav>/);
  if (!match) throw new Error("missing App nav");
  return match[0];
}

function marketingNav(html: string): string {
  const match = html.match(/<nav[^>]*aria-label="Sections"[\s\S]*?<\/nav>/);
  if (!match) throw new Error("missing Sections nav");
  return match[0];
}

function walletSlot(html: string): string {
  const match = html.match(/<div class="[^"]*" data-testid="nav-wallets">[\s\S]*?<\/div>/);
  if (!match) throw new Error("missing nav-wallets");
  return match[0];
}

const pool: HomepagePool = {
  key: "solana:tsla-raydium",
  chain: "solana",
  protocol: "raydium-clmm",
  poolAddress: "tsla-raydium",
  pairLabel: "TSLAx/TSLA",
  symbolA: "TSLAx",
  symbolB: "TSLA",
  nameA: "TSLAx",
  nameB: "TSLA",
  mintA: "TSLAx-mint",
  mintB: "TSLA-mint",
  feeTierBps: 25,
  tvlUsd: 80_000,
  volume24hUsd: 2_000,
  poolFeeApr24hPct: 12,
};

describe("SiteHeader", () => {
  it("lists Pools, Learn, AI agents, then Blog on marketing pages, with no Portfolio; Pools always goes to the list page", () => {
    const marketing = header("/learn");
    const marketingHrefs = hrefs(marketing);
    expect(marketingHrefs).toEqual(expect.arrayContaining(["/", "/pools", "/learn", "/app/ai", "/blog"]));
    expect(marketingHrefs).not.toContain("/app/portfolio");
    expect(marketingHrefs).not.toContain("#pools");
    expect(marketingHrefs).not.toContain("/#pools");
    expect(labels(marketingNav(marketing))).toEqual(["Pools", "Learn", "AI agents", "Blog"]);
    expect(marketing).toContain('data-testid="nav-menu"');
    expect(marketing).toContain("AI agents");
    expect(marketing).not.toContain("Use AI");
    expect(marketing).not.toMatch(/hidden flex-1 sm:flex/);
    expect(marketing).not.toContain("Portfolio");
  });

  it("lists Pools, Portfolio, AI agents on the app group, with no Learn or Blog", () => {
    const app = header("/app/portfolio");
    expect(hrefs(app)).toEqual(expect.arrayContaining(["/", "/pools", "/app/portfolio", "/app/ai"]));
    expect(hrefs(app)).not.toContain("/blog");
    expect(hrefs(app)).not.toContain("/learn");
    expect(app).toContain('aria-label="App"');
    expect(app).not.toContain('aria-label="Sections"');
    expect(labels(appNav(app))).toEqual(["Pools", "Portfolio", "AI agents"]);
    expect(app).not.toContain("Use AI");
    expect(app).not.toContain('data-testid="home-wallet"');
  });

  it("uses the same InkNav wallet slot on every page; the cream Connect wallet button is gone", () => {
    const marketing = header("/learn");
    const app = header("/app/portfolio");
    const poolPage = header("/pools/tsla-tslax");
    for (const html of [marketing, app, poolPage]) {
      expect(html).toContain('data-testid="nav-wallets"');
      expect(html).toContain('data-testid="nav-solana-wallet"');
      expect(html).toContain('data-testid="nav-evm-wallet"');
      expect(html).not.toContain('data-testid="home-wallet"');
      expect(html).not.toContain("Open app");
    }
    expect(walletSlot(marketing)).toBe(walletSlot(app));
    expect(walletSlot(poolPage)).toBe(walletSlot(app));
  });

  it("renders identical headers within each group (same links and wallet slot; only the active tab may differ)", () => {
    const linkList = (navHtml: string) => [...navHtml.matchAll(/href="([^"]*)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    const marketingPages = ["/", "/learn", "/blog", "/blog/xstocks-xpoints", "/fees", "/terms", "/faq", "/docs", "/docs/fees"];
    const marketing = marketingPages.map((path) => header(path));
    const marketingLinks = marketing.map((html) => linkList(marketingNav(html)));
    const marketingWallets = marketing.map(walletSlot);
    for (const links of marketingLinks) expect(links).toEqual(marketingLinks[0]);
    for (const slot of marketingWallets) expect(slot).toBe(marketingWallets[0]);
    for (const html of marketing) {
      expect(labels(marketingNav(html))).toEqual(["Pools", "Learn", "AI agents", "Blog"]);
      expect(html).not.toContain("Portfolio");
      expect(html).not.toContain('data-testid="home-wallet"');
    }

    const appPages = ["/pools", "/pools/tsla-tslax", "/app/portfolio", "/app/ai", "/app/sign/token", "/app/portfolio/recovery"];
    const apps = appPages.map((path) => header(path));
    const appLinks = apps.map((html) => linkList(appNav(html)));
    const appWallets = apps.map(walletSlot);
    for (const links of appLinks) expect(links).toEqual(appLinks[0]);
    for (const slot of appWallets) expect(slot).toBe(appWallets[0]);
    for (const html of apps) {
      expect(labels(appNav(html))).toEqual(["Pools", "Portfolio", "AI agents"]);
      expect(appNav(html)).not.toContain("Learn");
      expect(appNav(html)).not.toContain("Blog");
    }
  });

  it("is the marketing header on the blog, docs, FAQ, terms, learn and 404 pages", () => {
    nav.pathname = "/docs";
    const pages: Record<string, string> = {
      blog: renderToStaticMarkup(createElement(BlogShell, null, "x")),
      docs: renderToStaticMarkup(createElement(DocsShell, null, "x")),
      faq: renderToStaticMarkup(createElement(FaqPage)),
      terms: renderToStaticMarkup(createElement(TermsPage)),
      learn: renderToStaticMarkup(createElement(LearnPage)),
      notFound: renderToStaticMarkup(createElement(NotFound)),
    };
    for (const [name, html] of Object.entries(pages)) {
      expect(html, name).toContain('data-testid="site-header"');
      expect(html, name).toContain('data-testid="site-footer"');
      expect(html, name).toContain('data-testid="nav-wallets"');
      expect(html, name).not.toContain('data-testid="home-wallet"');
      expect(html, name).not.toContain('aria-label="App"');
      expect(labels(marketingNav(html)), name).toEqual(["Pools", "Learn", "AI agents", "Blog"]);
    }
  });

  it("uses the app header on public pool pages, without wrapping the page in Providers", () => {
    nav.pathname = "/pools/tsla-tslax";
    const html = renderToStaticMarkup(createElement(PublicPoolPage, { model: publicPoolPageModel(pool, 10.5, "tsla-tslax") }));
    expect(labels(appNav(html))).toEqual(["Pools", "Portfolio", "AI agents"]);
    expect(appNav(html)).not.toContain("Learn");
    expect(appNav(html)).not.toContain("Blog");
    expect(html).toContain('data-testid="nav-wallets"');
    expect(html).not.toContain('data-testid="home-wallet"');
    expect(html).not.toContain("WalletProvider");
    expect(html).not.toContain("ConnectionProvider");
  });

  it("renders a bare cream squircle H mark and wordmark, with no lemon capsule, and the logo always goes home", () => {
    const html = header("/");
    expect(html).toContain('href="/"');
    expect(html).toContain('src="/navbar-mark-squircle-cream.svg"');
    expect(html).toContain('width="36"');
    expect(html).toContain('height="36"');
    expect(html).toContain("h-9 w-9 max-w-none shrink-0 object-contain");
    expect(html).toContain("flex h-9 w-9 shrink-0 items-center justify-center overflow-visible");
    expect(html).toContain("flex shrink-0 items-center gap-2");
    expect(html).toContain("sm:gap-2.5");
    expect(html).toContain("font-display");
    expect(html).toContain("text-[16px]");
    expect(html).toContain("sm:text-[20px]");
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

  it("keeps the site header on /app/sign/[token] and does not render a footer", () => {
    const sign = readFileSync(resolve("src/app/app/sign/[token]/page.tsx"), "utf8");
    expect(sign).toContain("<SiteHeader wallet=");
    expect(sign).not.toContain("variant=");
    expect(sign).not.toContain("SiteFooter");
    expect(sign).not.toContain("site-footer");
  });

  it("the homepage and marketing pages render SiteHeader; Blog is marketing-only", () => {
    expect(readFileSync(resolve("src/components/landing-page.tsx"), "utf8")).toContain("<SiteHeader />");
    const headerSrc = readFileSync(resolve("src/components/site-header.tsx"), "utf8");
    expect(headerSrc).not.toContain("variant=");
    expect(headerSrc).not.toContain('variant ===');
    expect(headerSrc).toContain("BLOG_ROUTES.home");
    expect(headerSrc).toContain('label: "AI agents"');
    expect(headerSrc).not.toContain('label: "Use AI"');
    expect(headerSrc).not.toContain("#pools");
    expect(headerSrc).toContain("HomepageWalletIsland");
    expect(headerSrc).not.toContain("HomepageConnectButton");
    const ink = readFileSync(resolve("src/components/ink/InkNav.tsx"), "utf8");
    expect(ink).not.toMatch(/label: "Blog"/);
    expect(ink).not.toContain("BLOG_ROUTES");
  });

  it("puts a skip link to #main at the top of the header, and shells expose that landmark", () => {
    const html = header("/docs");
    expect(html).toMatch(/<a[^>]*href="#main"[^>]*>Skip to content<\/a>/);
    nav.pathname = "/docs";
    const pages = {
      blog: createElement(BlogShell, null, "x"),
      docs: createElement(DocsShell, null, "x"),
      faq: createElement(FaqPage),
      terms: createElement(TermsPage),
      notFound: createElement(NotFound),
    };
    for (const [name, el] of Object.entries(pages)) {
      const page = renderToStaticMarkup(el);
      expect(page, name).toContain('href="#main"');
      expect(page, name).toContain("Skip to content");
      expect(page, name).toContain('id="main"');
    }
  });
});
