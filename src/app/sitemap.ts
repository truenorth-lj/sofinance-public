import type { MetadataRoute } from "next";
import { articleCanonicalPath, listBlogArticles } from "@/lib/blog";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { APP_ROUTES, BLOG_ROUTES, FAQ_ROUTE, getCanonicalSiteUrl } from "@/lib/public-urls";

/**
 * Last real edit of the hand-written public copy (docs and FAQ). Bump when that copy changes; a build date would
 * claim changes that did not happen.
 */
export const PUBLIC_COPY_UPDATED = "2026-10-30";

type SitemapEntry = {
  path: string;
  lastModified: string;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
};

/** Public indexable pages on main: marketing home, pools, docs, FAQ and blog, each with its last-modified date. */
export function publicSitemapEntries(buildTime = new Date().toISOString()): SitemapEntry[] {
  const articles = listBlogArticles();
  const newestArticle = articles.map((article) => article.dateModified).sort().at(-1) ?? PUBLIC_COPY_UPDATED;
  return [
    // The homepage and pools list show live pool data: their content changes with every snapshot.
    { path: "/", lastModified: buildTime, changeFrequency: "daily" },
    { path: APP_ROUTES.rwaPairs, lastModified: buildTime, changeFrequency: "daily" },
    ...DOCS_PAGES.map((page) => ({ path: page.href, lastModified: PUBLIC_COPY_UPDATED, changeFrequency: "monthly" as const })),
    { path: FAQ_ROUTE, lastModified: PUBLIC_COPY_UPDATED, changeFrequency: "monthly" },
    { path: BLOG_ROUTES.home, lastModified: newestArticle, changeFrequency: "weekly" },
    ...articles.map((article) => ({
      path: articleCanonicalPath(article.slug),
      lastModified: article.dateModified,
      changeFrequency: "monthly" as const,
    })),
  ];
}

export function publicSitemapPaths(): string[] {
  return publicSitemapEntries().map((entry) => entry.path);
}

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getCanonicalSiteUrl();
  return publicSitemapEntries().map((entry) => ({
    url: entry.path === "/" ? base : `${base}${entry.path}`,
    lastModified: entry.lastModified,
    changeFrequency: entry.changeFrequency,
  }));
}
