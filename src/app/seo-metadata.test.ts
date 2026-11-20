import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { articleCanonicalPath, listBlogArticles } from "@/lib/blog";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { GUIDE_PAGES } from "@/lib/guides";
import { APP_ROUTES, BLOG_ROUTES, CANONICAL_SITE_URL, FAQ_ROUTE, GUIDE_ROUTES, LEGAL_ROUTES } from "@/lib/public-urls";
import { config as proxyConfig } from "@/proxy";
import robots, { AI_CRAWLER_USER_AGENTS } from "./robots";
import { PUBLIC_COPY_UPDATED, TERMS_UPDATED, publicSitemapEntries, publicSitemapPaths, revalidate as sitemapRevalidate, toSitemapUrls } from "./sitemap";

function docsHrefsFromAppDir(root = resolve("src/app/docs")): string[] {
  const hrefs: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${url}/${name}`);
      else if (name === "page.tsx") hrefs.push(url);
    }
  };
  walk(root, "/docs");
  return hrefs.sort();
}

describe("SEO metadata routes", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it("indexes the homepage, RWA pairs, every docs page, the FAQ, every guide page, and every blog article", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const guidePaths = [GUIDE_ROUTES.learn, ...GUIDE_PAGES.map((page) => page.path)];
    expect(guidePaths).toEqual([
      "/learn",
      "/fees",
      "/learn/what-is-a-same-stock-lp-pool",
      "/learn/how-to-open-an-lp-position",
      "/learn/impermanent-loss-on-same-stock-pools",
      "/use-cases/tsla-same-stock-lp",
      "/use-cases/spcx-same-stock-lp",
    ]);
    const blogPaths = [BLOG_ROUTES.home, ...listBlogArticles().map((article) => articleCanonicalPath(article.slug))];
    expect(publicSitemapPaths()).toEqual([
      "/",
      APP_ROUTES.rwaPairs,
      ...DOCS_PAGES.map((page) => page.href),
      FAQ_ROUTE,
      LEGAL_ROUTES.terms,
      ...guidePaths,
      ...blogPaths,
    ]);
    expect(docsHrefsFromAppDir()).toEqual([...DOCS_PAGES.map((page) => page.href)].sort());
    expect(blogPaths).toContain("/blog");
    expect(blogPaths).toContain("/blog/dex-evolution");
    expect(blogPaths).toContain("/blog/xstocks-xpoints");
    expect(blogPaths).toContain("/blog/competitor-comparison");

    const urls = toSitemapUrls(publicSitemapEntries()).map((entry) => entry.url);
    expect(urls).toEqual([
      CANONICAL_SITE_URL,
      `${CANONICAL_SITE_URL}/pools`,
      ...DOCS_PAGES.map((page) => `${CANONICAL_SITE_URL}${page.href}`),
      `${CANONICAL_SITE_URL}/faq`,
      `${CANONICAL_SITE_URL}/terms`,
      ...guidePaths.map((path) => `${CANONICAL_SITE_URL}${path}`),
      ...blogPaths.map((path) => `${CANONICAL_SITE_URL}${path}`),
    ]);
    expect(urls).toContain(`${CANONICAL_SITE_URL}/terms`);
    expect(urls.join("\n")).not.toMatch(/\/api\/|\/app\/sign|\/app\/plan|\/position-performance/);
  });

  it("gives every sitemap entry a real lastModified date", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const entries = toSitemapUrls(publicSitemapEntries());
    for (const entry of entries) {
      expect(entry.lastModified, entry.url).toBeTruthy();
      expect(Number.isFinite(Date.parse(String(entry.lastModified))), entry.url).toBe(true);
    }
    const byUrl = new Map(entries.map((entry) => [entry.url, entry]));
    expect(byUrl.get(`${CANONICAL_SITE_URL}/faq`)?.lastModified).toBe(PUBLIC_COPY_UPDATED);
    expect(byUrl.get(`${CANONICAL_SITE_URL}/terms`)?.lastModified).toBe(TERMS_UPDATED);
    expect(byUrl.get(`${CANONICAL_SITE_URL}/docs/fee-apr`)?.lastModified).toBe(PUBLIC_COPY_UPDATED);
    for (const article of listBlogArticles()) {
      expect(byUrl.get(`${CANONICAL_SITE_URL}${articleCanonicalPath(article.slug)}`)?.lastModified).toBe(article.dateModified);
    }
    expect(entries.map((entry) => entry.url).join("\n")).not.toContain("yield-and-apr");
  });

  it("allows crawlers, blocks /api/, names AI crawlers, and points at the production sitemap", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const allowPublic = { allow: "/", disallow: ["/api/", "/lumen/"] };
    expect(robots()).toEqual({
      rules: [
        { userAgent: "*", ...allowPublic },
        { userAgent: [...AI_CRAWLER_USER_AGENTS], ...allowPublic },
      ],
      sitemap: `${CANONICAL_SITE_URL}/sitemap.xml`,
      host: CANONICAL_SITE_URL,
    });
    expect(AI_CRAWLER_USER_AGENTS).toEqual(expect.arrayContaining([
      "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot",
      "PerplexityBot", "Google-Extended", "Applebot-Extended",
    ]));
  });

  it("keeps sitemap.xml, robots.txt and llms.txt out of the Next.js proxy matcher", () => {
    const matcher = proxyConfig.matcher.join(" ");
    expect(matcher).toContain("sitemap.xml");
    expect(matcher).toContain("llms.txt");
    expect(matcher).toContain("robots.txt");
    const proxySource = readFileSync(resolve("src/proxy.ts"), "utf8");
    expect(proxySource).toContain("sitemap.xml|robots.txt");
  });

  it("appends /pools/{slug} sitemap extras without changing the static public set", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const extra = [
      { path: "/pools/tsla-tslax", lastModified: "2026-11-20T00:00:00.000Z", changeFrequency: "daily" as const },
      { path: "/pools/tsla-tslax-meteora", lastModified: "2026-11-20T00:00:00.000Z", changeFrequency: "daily" as const },
    ];
    const paths = publicSitemapEntries("2026-11-20T00:00:00.000Z", extra).map((entry) => entry.path);
    expect(paths).toContain("/pools/tsla-tslax");
    expect(paths).toContain("/pools/tsla-tslax-meteora");
    expect(publicSitemapPaths()).not.toContain("/pools/tsla-tslax");
    const urls = toSitemapUrls(publicSitemapEntries("2026-11-20T00:00:00.000Z", extra)).map((entry) => entry.url);
    expect(urls).toContain(`${CANONICAL_SITE_URL}/pools/tsla-tslax`);
    expect(urls).toContain(`${CANONICAL_SITE_URL}/pools/tsla-tslax-meteora`);
  });

  it("exports an ISR revalidate window so /sitemap.xml can pick up new pool slugs without a redeploy", () => {
    // Next only treats `export const revalidate = <number>` as the route segment config.
    expect(sitemapRevalidate).toBe(900);
    const sitemapSource = readFileSync(resolve("src/app/sitemap.ts"), "utf8");
    expect(sitemapSource).toMatch(/export const revalidate = 900\b/);
    expect(sitemapSource).not.toMatch(/force-dynamic/);
    const snapshotSource = readFileSync(resolve("src/lib/homepage-pools-snapshot.ts"), "utf8");
    const snapshotWindow = snapshotSource.match(/export const HOMEPAGE_POOLS_REVALIDATE_SECONDS = (\d+)/);
    expect(Number(snapshotWindow?.[1])).toBe(sitemapRevalidate);
    const poolPageSource = readFileSync(resolve("src/app/pools/[slug]/page.tsx"), "utf8");
    expect(poolPageSource).toMatch(/export const revalidate = 900\b/);
  });
});
