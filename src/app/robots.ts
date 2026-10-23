import type { MetadataRoute } from "next";
import { getCanonicalSiteUrl } from "@/lib/public-urls";
import { POSTHOG_RELAY_PATH } from "@/lib/analytics/relay";

export default function robots(): MetadataRoute.Robots {
  const base = getCanonicalSiteUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", `${POSTHOG_RELAY_PATH}/`],
    },
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
