import type { MetadataRoute } from "next";
import { articleCanonicalPath, listBlogArticles } from "@/lib/blog";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { GUIDE_PAGES, GUIDES_UPDATED } from "@/lib/guides";
import { poolSitemapEntries } from "@/lib/public-pool-pages";
import { APP_ROUTES, BLOG_ROUTES, FAQ_ROUTE, GUIDE_ROUTES, LEGAL_ROUTES, getCanonicalSiteUrl } from "@/lib/public-urls";

/**
 * Last real edit of the hand-written public copy (docs and FAQ). Bump when that copy changes; a build date would
 * claim changes that did not happen.
 */
export const PUBLIC_COPY_UPDATED = "2026-10-30";
/** Last legal-copy edit of /terms (#139). Later commits only swapped the marketing header. */
export const TERMS_UPDATED = "2026-10-24";

/**
 * Same ISR window as /pools/[slug], the homepage, /app/rwa-pairs, and
 * HOMEPAGE_POOLS_REVALIDATE_SECONDS. Without this, Next prerenders /sitemap.xml
 * once per deploy and new pool slugs stay missing until the next build.
 * This is ISR (at most one regeneration per window, and only if the sitemap is
 * requested after it goes stale) — not per-request dynamic rendering.
 */
export const revalidate = 900;

type SitemapEntry = {
  path: string;
  lastModified: string;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
};

/** Public indexable pages on main: marketing home, pools, docs, FAQ, guides (pricing, learn, use cases) and blog, each with its last-modified date. */
export function publicSitemapEntries(buildTime = new Date().toISOString(), extra: SitemapEntry[] = []): SitemapEntry[] {
  const articles = listBlogArticles();
  const newestArticle = articles.map((article) => article.dateModified).sort().at(-1) ?? PUBLIC_COPY_UPDATED;
  return [
    // The homepage and pools list show live pool data: their content changes with every snapshot.
    { path: "/", lastModified: buildTime, changeFrequency: "daily" },
    { path: APP_ROUTES.rwaPairs, lastModified: buildTime, changeFrequency: "daily" },
    ...DOCS_PAGES.map((page) => ({ path: page.href, lastModified: PUBLIC_COPY_UPDATED, changeFrequency: "monthly" as const })),
    { path: FAQ_ROUTE, lastModified: PUBLIC_COPY_UPDATED, changeFrequency: "monthly" },
    { path: LEGAL_ROUTES.terms, lastModified: TERMS_UPDATED, changeFrequency: "yearly" },
    { path: GUIDE_ROUTES.learn, lastModified: GUIDES_UPDATED, changeFrequency: "monthly" },
    ...GUIDE_PAGES.map((page) => ({ path: page.path, lastModified: page.updated, changeFrequency: "monthly" as const })),
    { path: BLOG_ROUTES.home, lastModified: newestArticle, changeFrequency: "weekly" },
    ...articles.map((article) => ({
      path: articleCanonicalPath(article.slug),
      lastModified: article.dateModified,
      changeFrequency: "monthly" as const,
    })),
    ...extra,
  ];
}

export function publicSitemapPaths(): string[] {
  return publicSitemapEntries().map((entry) => entry.path);
}

export function toSitemapUrls(entries: SitemapEntry[]): MetadataRoute.Sitemap {
  const base = getCanonicalSiteUrl();
  return entries.map((entry) => ({
    url: entry.path === "/" ? base : `${base}${entry.path}`,
    lastModified: entry.lastModified,
    changeFrequency: entry.changeFrequency,
  }));
}

/** Includes /pools/{slug} entries from the cached snapshot when it is available. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const buildTime = new Date().toISOString();
  // Dynamic import keeps this file importable from unit tests (homepage-pools-snapshot is server-only).
  const { loadHomepagePoolsSnapshot } = await import("@/lib/homepage-pools-snapshot");
  const extra = poolSitemapEntries(await loadHomepagePoolsSnapshot(), buildTime);
  return toSitemapUrls(publicSitemapEntries(buildTime, extra));
}
