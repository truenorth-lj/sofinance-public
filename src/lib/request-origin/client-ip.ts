import { processHeaderEnv, trustedEdges, type HeaderEnv } from "./trust";

/**
 * Client IP for per-instance rate limits, from the first trusted source that has one:
 * 1. `CF-Connecting-IP`, only when Cloudflare headers are trusted (`trust.ts`). Behind a Cloudflare proxy the
 *    origin's `x-real-ip` is a Cloudflare edge address, which would put every visitor in one bucket.
 * 2. `x-real-ip` (set by Vercel and by Railway's edge).
 * 3. The first `x-forwarded-for` entry.
 * Otherwise `"unknown"`. Without the Cloudflare opt-in this is exactly the previous parsing.
 */
export function clientIp(request: Request, env: HeaderEnv = processHeaderEnv()): string {
  const { headers } = request;
  const cloudflare = trustedEdges(env).cloudflare ? headers.get("cf-connecting-ip")?.trim() : undefined;
  return cloudflare
    || headers.get("x-real-ip")?.trim()
    || headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}
