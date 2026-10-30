import type { MetadataRoute } from "next";
import { articleCanonicalPath, listBlogArticles } from "@/lib/blog";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { APP_ROUTES, BLOG_ROUTES, getCanonicalSiteUrl } from "@/lib/public-urls";

/** Public indexable paths on main: marketing home, RWA pairs, docs, and blog. */
export function publicSitemapPaths(): string[] {
  return [
    "/",
    APP_ROUTES.rwaPairs,
    ...DOCS_PAGES.map((page) => page.href),
    BLOG_ROUTES.home,
    ...listBlogArticles().map((article) => articleCanonicalPath(article.slug)),
  ];
}

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getCanonicalSiteUrl();
  return publicSitemapPaths().map((path) => ({
    url: path === "/" ? base : `${base}${path}`,
  }));
}
