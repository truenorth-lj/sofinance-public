import type { MetadataRoute } from "next";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { APP_ROUTES, getCanonicalSiteUrl } from "@/lib/public-urls";

/** Public indexable paths on main: marketing home, RWA pairs, and every docs page. */
export function publicSitemapPaths(): string[] {
  return ["/", APP_ROUTES.rwaPairs, ...DOCS_PAGES.map((page) => page.href)];
}

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getCanonicalSiteUrl();
  return publicSitemapPaths().map((path) => ({
    url: path === "/" ? base : `${base}${path}`,
  }));
}
