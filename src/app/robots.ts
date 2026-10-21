import type { MetadataRoute } from "next";
import { getCanonicalSiteUrl } from "@/lib/public-urls";

export default function robots(): MetadataRoute.Robots {
  const base = getCanonicalSiteUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    },
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
