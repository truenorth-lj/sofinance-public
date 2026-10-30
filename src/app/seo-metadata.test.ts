import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { articleCanonicalPath, listBlogArticles } from "@/lib/blog";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { APP_ROUTES, BLOG_ROUTES, CANONICAL_SITE_URL, FAQ_ROUTE } from "@/lib/public-urls";
import { config as proxyConfig } from "@/proxy";
import robots from "./robots";
import sitemap, { PUBLIC_COPY_UPDATED, publicSitemapPaths } from "./sitemap";

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

  it("indexes the homepage, RWA pairs, every docs page, the FAQ, and every blog article", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const blogPaths = [BLOG_ROUTES.home, ...listBlogArticles().map((article) => articleCanonicalPath(article.slug))];
    expect(publicSitemapPaths()).toEqual([
      "/",
      APP_ROUTES.rwaPairs,
      ...DOCS_PAGES.map((page) => page.href),
      FAQ_ROUTE,
      ...blogPaths,
    ]);
    expect(docsHrefsFromAppDir()).toEqual([...DOCS_PAGES.map((page) => page.href)].sort());
    expect(blogPaths).toContain("/blog");
    expect(blogPaths).toContain("/blog/dex-evolution");
    expect(blogPaths).toContain("/blog/xstocks-xpoints");

    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual([
      CANONICAL_SITE_URL,
      `${CANONICAL_SITE_URL}/app/rwa-pairs`,
      ...DOCS_PAGES.map((page) => `${CANONICAL_SITE_URL}${page.href}`),
      `${CANONICAL_SITE_URL}/faq`,
      ...blogPaths.map((path) => `${CANONICAL_SITE_URL}${path}`),
    ]);
    expect(urls.join("\n")).not.toMatch(/\/terms|\/api\/|\/app\/sign|\/app\/plan|\/position-performance/);
  });

  it("gives every sitemap entry a real lastModified date", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const entries = sitemap();
    for (const entry of entries) {
      expect(entry.lastModified, entry.url).toBeTruthy();
      expect(Number.isFinite(Date.parse(String(entry.lastModified))), entry.url).toBe(true);
    }
    const byUrl = new Map(entries.map((entry) => [entry.url, entry]));
    expect(byUrl.get(`${CANONICAL_SITE_URL}/faq`)?.lastModified).toBe(PUBLIC_COPY_UPDATED);
    expect(byUrl.get(`${CANONICAL_SITE_URL}/docs/fee-apr`)?.lastModified).toBe(PUBLIC_COPY_UPDATED);
    for (const article of listBlogArticles()) {
      expect(byUrl.get(`${CANONICAL_SITE_URL}${articleCanonicalPath(article.slug)}`)?.lastModified).toBe(article.dateModified);
    }
    expect(entries.map((entry) => entry.url).join("\n")).not.toContain("yield-and-apr");
  });

  it("allows crawlers, blocks /api/, and points at the production sitemap", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/lumen/"],
      },
      sitemap: `${CANONICAL_SITE_URL}/sitemap.xml`,
      host: CANONICAL_SITE_URL,
    });
  });

  it("keeps sitemap.xml, robots.txt and llms.txt out of the Next.js proxy matcher", () => {
    const matcher = proxyConfig.matcher.join(" ");
    expect(matcher).toContain("sitemap.xml");
    expect(matcher).toContain("llms.txt");
    expect(matcher).toContain("robots.txt");
    const proxySource = readFileSync(resolve("src/proxy.ts"), "utf8");
    expect(proxySource).toContain("sitemap.xml|robots.txt");
  });
});
