import { createElement } from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/learn",
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useParams: () => ({}),
}));

vi.mock("@/components/wallet-connection", () => ({
  useWalletConnection: () => ({
    address: null,
    connected: false,
    restoring: false,
    connect: () => {},
    disconnect: () => {},
  }),
}));

import { PageHeader, PAGE_HEADER_TITLE_CLASS, PAGE_HEADER_SUBLINE_CLASS } from "./page-header";
import LearnIndexPage from "@/app/learn/page";
import FaqPage from "@/app/faq/page";
import TermsPage from "@/app/terms/page";
import NotFound from "@/app/not-found";
import BlogIndexPage from "@/app/blog/page";
import AIManagementPage from "@/app/app/ai/page";
import { BlogArticleView } from "@/components/blog/blog-article-view";
import { DocsArticle } from "@/components/docs/docs-article";
import { GuideArticle } from "@/components/guides/guide-article";
import { PublicPoolPage } from "@/components/public-pool-page";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { GUIDE_PAGES } from "@/lib/guides";
import { listBlogArticles } from "@/lib/blog";
import { TERMS_LAST_UPDATED } from "@/lib/terms-content";
import type { HomepagePool } from "@/lib/homepage-pools";
import { publicPoolPageModel } from "@/lib/public-pool-pages";

const decode = (text: string) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");

const h1s = (html: string) =>
  [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((match) =>
    decode((match[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).trim(),
  );

const visible = (html: string) =>
  decode(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));

const pageHeader = (html: string) => {
  const start = html.indexOf('data-testid="page-header"');
  if (start < 0) return "";
  const open = html.lastIndexOf("<div", start);
  return html.slice(open >= 0 ? open : start, start + 2500);
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === ".next") return [];
      return sourceFiles(path);
    }
    return /\.(tsx?|jsx?)$/.test(name) ? [path] : [];
  });
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

describe("PageHeader", () => {
  it("renders one h1 and a subline in the pools/portfolio typography", () => {
    const html = renderToStaticMarkup(createElement(PageHeader, { title: "Pools", subline: "A subline" }));
    expect(h1s(html)).toEqual(["Pools"]);
    expect(html).toContain(PAGE_HEADER_TITLE_CLASS);
    expect(html).toContain(PAGE_HEADER_SUBLINE_CLASS);
    expect(html).toContain("A subline");
    expect(html).not.toMatch(/rounded-\[28px\] bg-cream/);
  });
});

describe("converted page headers", () => {
  it("uses exactly one h1 and the existing title/subline wording on /learn, /faq, /terms and 404", () => {
    const pages = [
      { name: "learn", html: renderToStaticMarkup(createElement(LearnIndexPage)), title: "Same-stock LP, explained", subline: "Short guides that answer the common questions first: what a same-stock pool is, how to open a position, impermanent loss, pricing, and worked use cases." },
      { name: "faq", html: renderToStaticMarkup(createElement(FaqPage)), title: "Questions about same-stock LP", subline: "How liquidity providers collect trading fees, what tokenized stocks are, and where SoFinance fits." },
      { name: "terms", html: renderToStaticMarkup(createElement(TermsPage)), title: "Terms of Service", subline: `Last updated ${TERMS_LAST_UPDATED}` },
      { name: "not-found", html: renderToStaticMarkup(createElement(NotFound)), title: "This page does not exist.", subline: "Try the homepage, or open the pool list." },
    ];
    for (const page of pages) {
      expect(h1s(page.html), page.name).toEqual([page.title]);
      expect(visible(page.html), page.name).toContain(page.subline);
      expect(page.html, page.name).toContain('data-testid="page-header"');
      expect(pageHeader(page.html), page.name).toContain(PAGE_HEADER_TITLE_CLASS);
      expect(pageHeader(page.html), page.name).not.toMatch(/rounded-\[28px\] bg-cream/);
    }
    const faq = pages[1]!.html;
    expect(faq).toContain('href="/docs"');
  });

  it("uses the same header on /app/ai and keeps the existing wording", () => {
    const html = renderToStaticMarkup(createElement(AIManagementPage));
    expect(h1s(html)).toEqual(["Manage positions with AI"]);
    expect(visible(html)).toContain("Connect your wallet to get started with AI-powered position management via MCP");
    expect(html).toContain('data-testid="page-header"');
    expect(pageHeader(html)).toContain(PAGE_HEADER_TITLE_CLASS);
    expect(pageHeader(html)).not.toMatch(/rounded-\[28px\] bg-cream/);
  });

  it("uses exactly one h1 on every docs article, with the existing title and description", () => {
    for (const page of DOCS_PAGES) {
      const html = renderToStaticMarkup(<DocsArticle page={page}>body</DocsArticle>);
      expect(h1s(html), page.href).toEqual([page.title]);
      expect(visible(html), page.href).toContain(page.description);
      expect(pageHeader(html), page.href).toContain(PAGE_HEADER_TITLE_CLASS);
      expect(pageHeader(html), page.href).not.toMatch(/rounded-\[28px\] bg-cream/);
    }
  });

  it("uses exactly one h1 on every guide, including /fees, with the existing title, intro and updated line", () => {
    const paths = GUIDE_PAGES.map((page) => page.path);
    expect(paths).toContain("/fees");
    for (const page of GUIDE_PAGES) {
      const html = renderToStaticMarkup(createElement(GuideArticle, { page }));
      expect(h1s(html), page.path).toEqual([page.title]);
      expect(visible(html), page.path).toContain(page.intro);
      expect(visible(html), page.path).toContain(`Updated ${page.updated}`);
      expect(pageHeader(html), page.path).toContain(PAGE_HEADER_TITLE_CLASS);
      expect(pageHeader(html), page.path).not.toMatch(/rounded-\[28px\] bg-cream/);
    }
  });

  it("uses exactly one h1 on the blog index and each article, keeping the existing wording", () => {
    const index = renderToStaticMarkup(createElement(BlogIndexPage));
    expect(h1s(index)).toEqual(["Notes on on-chain market making"]);
    expect(visible(index)).toContain(
      "Long-form writing from SoFinance. How AMMs evolved, what negative gamma costs an LP, and how same-stock pools fit on that map.",
    );
    expect(pageHeader(index)).toContain(PAGE_HEADER_TITLE_CLASS);
    expect(pageHeader(index)).not.toMatch(/rounded-\[28px\] bg-cream/);

    const articles = listBlogArticles();
    expect(articles.length).toBeGreaterThan(0);
    for (const article of articles) {
      const html = renderToStaticMarkup(createElement(BlogArticleView, { article }));
      expect(h1s(html), article.slug).toEqual([article.title]);
      expect(visible(html), article.slug).toContain(article.description);
      expect(pageHeader(html), article.slug).toContain(PAGE_HEADER_TITLE_CLASS);
      expect(pageHeader(html), article.slug).not.toMatch(/rounded-\[28px\] bg-cream/);
    }
  });

  it("uses exactly one h1 on a public pool page", () => {
    const model = publicPoolPageModel(pool, 10.5, "tsla-tslax");
    const html = renderToStaticMarkup(createElement(PublicPoolPage, { model }));
    expect(h1s(html)).toEqual([model.title]);
    expect(visible(html)).toContain(model.aprHelp);
    expect(pageHeader(html)).toContain(PAGE_HEADER_TITLE_CLASS);
    expect(pageHeader(html)).not.toMatch(/rounded-\[28px\] bg-cream/);
  });

  it("does not change SEO metadata exports on the converted pages", () => {
    const learn = readFileSync(resolve("src/app/learn/page.tsx"), "utf8");
    expect(learn).toContain("pageMetadata({ title: LEARN_INDEX.metaTitle, description: LEARN_INDEX.metaDescription, path: LEARN_INDEX.path })");

    const faq = readFileSync(resolve("src/app/faq/page.tsx"), "utf8");
    expect(faq).toContain('title: "FAQ: LP fees, xStocks and tokenized stocks"');
    expect(faq).toContain("Plain answers on how liquidity providers collect trading fees, what xStocks, Backpack and Robinhood stock tokens are, how to buy stocks onchain, and where SoFinance fits.");

    const terms = readFileSync(resolve("src/app/terms/page.tsx"), "utf8");
    expect(terms).toContain('title: "Terms of Service"');
    expect(terms).toContain("Terms of Service for SoFinance, a self-custodial software interface for Raydium CLMM positions on Solana.");

    const fees = readFileSync(resolve("src/app/fees/page.tsx"), "utf8");
    expect(fees).toContain("pageMetadata({ title: page.metaTitle, description: page.metaDescription, path: page.path })");
    expect(fees).toContain('guideBySlug("pricing", "fees")');

    const docs = readFileSync(resolve("src/app/docs/page.tsx"), "utf8");
    expect(docs).toContain('docsPageMetadata("getting-started")');

    const blog = readFileSync(resolve("src/app/blog/page.tsx"), "utf8");
    expect(blog).toContain("export const metadata = blogIndexMetadata();");

    const sign = readFileSync(resolve("src/app/app/sign/[token]/page.tsx"), "utf8");
    expect(sign).toContain('title="Sign transaction"');
    expect(sign).toContain('subline="Review and sign the prepared transaction"');
    expect(sign).not.toContain("InkHero");

  });
});

describe("InkHero removal", () => {
  it("deletes the component and leaves no production imports", () => {
    expect(sourceFiles("src/components/ink")).not.toContain(resolve("src/components/ink/InkHero.tsx"));
    expect(readFileSync(resolve("src/components/ink/index.ts"), "utf8")).not.toContain("InkHero");
    for (const file of sourceFiles("src")) {
      if (/\.test\.(tsx?|jsx?)$/.test(file)) continue;
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toContain("InkHero");
    }
  });
});
