import type { MetadataRoute } from "next";
import { getCanonicalSiteUrl } from "@/lib/public-urls";
import { POSTHOG_RELAY_PATH } from "@/lib/analytics/relay";

/** Named groups so a later tightening of `*` cannot silently block AI crawlers. */
export const AI_CRAWLER_USER_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Google-Extended",
  "Applebot-Extended",
  "Amazonbot",
] as const;

export default function robots(): MetadataRoute.Robots {
  const base = getCanonicalSiteUrl();
  const allowPublic = { allow: "/", disallow: ["/api/", `${POSTHOG_RELAY_PATH}/`] };
  return {
    rules: [
      { userAgent: "*", ...allowPublic },
      { userAgent: [...AI_CRAWLER_USER_AGENTS], ...allowPublic },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
