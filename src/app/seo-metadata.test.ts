import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { articleCanonicalPath, listBlogArticles } from "@/lib/blog";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { APP_ROUTES, BLOG_ROUTES, CANONICAL_SITE_URL } from "@/lib/public-urls";
import { config as proxyConfig } from "@/proxy";
import robots from "./robots";
import sitemap, { publicSitemapPaths } from "./sitemap";

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

  it("indexes the homepage, RWA pairs, every docs page, and every blog article", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const blogPaths = [BLOG_ROUTES.home, ...listBlogArticles().map((article) => articleCanonicalPath(article.slug))];
    expect(publicSitemapPaths()).toEqual([
      "/",
      APP_ROUTES.rwaPairs,
      ...DOCS_PAGES.map((page) => page.href),
      ...blogPaths,
    ]);
    expect(docsHrefsFromAppDir()).toEqual([...DOCS_PAGES.map((page) => page.href)].sort());
    expect(blogPaths).toContain("/blog");
    expect(blogPaths).toContain("/blog/dex-evolution");

    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toEqual([
      CANONICAL_SITE_URL,
      `${CANONICAL_SITE_URL}/app/rwa-pairs`,
      `${CANONICAL_SITE_URL}/docs`,
      `${CANONICAL_SITE_URL}/docs/yield-and-apr`,
      `${CANONICAL_SITE_URL}/docs/risks`,
      `${CANONICAL_SITE_URL}/docs/fees`,
      `${CANONICAL_SITE_URL}/docs/withdraw`,
      `${CANONICAL_SITE_URL}/docs/security`,
      `${CANONICAL_SITE_URL}/blog`,
      `${CANONICAL_SITE_URL}/blog/dex-evolution`,
    ]);
    expect(urls.join("\n")).not.toMatch(/\/terms|\/api\/|\/app\/sign|\/app\/plan|\/position-performance/);
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

  it("keeps sitemap.xml and robots.txt out of the Next.js proxy matcher", () => {
    const matcher = proxyConfig.matcher.join(" ");
    expect(matcher).toContain("sitemap.xml");
    expect(matcher).toContain("robots.txt");
    const proxySource = readFileSync(resolve("src/proxy.ts"), "utf8");
    expect(proxySource).toContain("sitemap.xml|robots.txt");
  });
});
