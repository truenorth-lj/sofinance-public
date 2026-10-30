import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlogMarkdown } from "@/components/blog/blog-markdown";
import {
  BLOG_ORGANIZATION,
  blogArticleJsonLd,
  blogArticleMetadata,
  blogTimeProps,
  formatBlogDate,
  getBlogArticle,
  getPublicPngSize,
  listBlogArticles,
} from "./blog";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://sofinancelab.xyz");
});
afterEach(() => vi.unstubAllEnvs());

describe("blog content", () => {
  const articles = listBlogArticles();
  const first = getBlogArticle("dex-evolution");

  it("publishes dex-evolution with crawlable title, description, date, and hero", () => {
    expect(first).not.toBeNull();
    expect(first?.title).toBe(
      "From x·y=k to Oracle Pools: How On-Chain Market Making Learned to Live With Negative Gamma",
    );
    expect(first?.description).toMatch(/Constant-product AMMs/);
    expect(first?.datePublished).toBe("2026-10-23");
    expect(first?.dateModified).toBe("2026-10-23");
    expect(first?.hero.src).toBe("/blog/dex-evolution/hero-evolution.png");
    expect(first?.hero.alt).toBe("Three stages of on-chain market making");
    expect(first?.body).toContain("Every DEX liquidity provider is quietly running a trade.");
    expect(first?.body).toContain("| Approach | Price source | How liquidity moves |");
    expect(first?.body).not.toContain("Editor note");
    expect(articles.map((article) => article.slug)).toContain("dex-evolution");
  });

  it("never attributes an article to a person", () => {
    const blob = [
      readFileSync(resolve("src/lib/blog.ts"), "utf8"),
      readFileSync(resolve("content/blog/dex-evolution.md"), "utf8"),
      readFileSync(resolve("src/components/blog/blog-article-view.tsx"), "utf8"),
    ].join("\n");
    expect(blob).not.toMatch(/author:\s*["'][^"']+["']/i);
    expect(BLOG_ORGANIZATION).toBe("SoFinance");
    expect(first && blogArticleJsonLd(first)).toMatchObject({
      "@graph": [
        {
          "@type": "BlogPosting",
          author: { "@type": "Organization", name: "SoFinance" },
          publisher: { "@type": "Organization", name: "SoFinance" },
        },
        { "@type": "BreadcrumbList" },
      ],
    });
  });

  it("emits article metadata, canonical URL, OG image, and a large Twitter card", () => {
    expect(first).not.toBeNull();
    const metadata = blogArticleMetadata(first!);
    expect(metadata.alternates).toEqual({ canonical: "https://sofinancelab.xyz/blog/dex-evolution" });
    expect(metadata.openGraph).toMatchObject({
      type: "article",
      url: "https://sofinancelab.xyz/blog/dex-evolution",
      images: [
        {
          url: "https://sofinancelab.xyz/blog/dex-evolution/hero-evolution.png",
          alt: "Three stages of on-chain market making",
        },
      ],
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      images: ["https://sofinancelab.xyz/blog/dex-evolution/hero-evolution.png"],
    });
  });

  it("renders the comparison as a real HTML table and figures for article images", () => {
    expect(first).not.toBeNull();
    const html = renderToStaticMarkup(<BlogMarkdown body={first!.body} />);
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).not.toContain("<p class=\"mt-4 first:mt-0\"><figure");
    expect(html).toContain("How liquidity moves");
    expect(html).toContain("Metric active pools");
    expect(html).toContain("<figure");
    expect(html).toContain("<figcaption");
    expect(html).toContain("payoff-gamma.png");
    expect(html).toContain("liquidity-behavior.png");
    expect(html).toContain("comparison-table.png");
    expect(html).toContain('href="/app?ref=x-article#pools"');
  });

  it("reads PNG dimensions from public files and formats dates without locale drift", () => {
    expect(getPublicPngSize("/blog/dex-evolution/hero-evolution.png")).toEqual({ width: 1500, height: 600 });
    expect(formatBlogDate("2026-10-23")).toBe("October 23, 2026");
    expect(blogTimeProps("2026-10-23")).toEqual({ datetime: "2026-10-23" });
  });

  it("keeps the article body on the same full-width column as the header and hero", () => {
    const src = readFileSync(resolve("src/components/blog/blog-article-view.tsx"), "utf8");
    expect(src).not.toMatch(/mx-auto\s+mt-3\s+max-w-3xl/);
    expect(src).toContain('className="mt-3 w-full rounded-[28px]');
    expect(src).toContain("<header className=\"mt-3 rounded-[28px]");
    expect(src).toContain("<figure className=\"mt-3 overflow-hidden rounded-[28px]");
  });
});
