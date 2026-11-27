/**
 * Which hosting edge's request headers this deployment may believe.
 *
 * A geo or client-IP header is only meaningful when the edge in front of the app sets it and strips any copy the
 * client sent. A header from an edge we are not behind is attacker-controlled, so each edge is trusted only where it
 * actually sits in front of the app:
 *
 * - Cloudflare (`CF-IPCountry`, `CF-Connecting-IP`): only with `SOFINANCE_TRUST_CLOUDFLARE_HEADERS=true`, set on a
 *   deployment whose public domain is proxied through Cloudflare (orange cloud). Off by default everywhere, so on
 *   Vercel a client-sent `CF-IPCountry` can never override Vercel's own header.
 * - Vercel (`x-vercel-ip-country`): trusted everywhere except on Railway, which is exactly today's behavior on Vercel,
 *   in local dev and in tests. Railway's edge passes a client-sent `x-vercel-*` header through, so it is ignored there.
 */
export type HeaderEnv = Readonly<Partial<Record<"RAILWAY_PROJECT_ID" | "SOFINANCE_TRUST_CLOUDFLARE_HEADERS", string>>>;

/** Only the two names this module needs, read at call time (never the whole `process.env`). */
export function processHeaderEnv(): HeaderEnv {
  return {
    RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID,
    SOFINANCE_TRUST_CLOUDFLARE_HEADERS: process.env.SOFINANCE_TRUST_CLOUDFLARE_HEADERS,
  };
}

export interface TrustedEdges {
  readonly cloudflare: boolean;
  readonly vercel: boolean;
}

/** Railway injects `RAILWAY_PROJECT_ID` into every deployment at runtime. */
export function isRailwayRuntime(env: HeaderEnv = processHeaderEnv()): boolean {
  return !!env.RAILWAY_PROJECT_ID?.trim();
}

export function trustedEdges(env: HeaderEnv = processHeaderEnv()): TrustedEdges {
  return {
    cloudflare: env.SOFINANCE_TRUST_CLOUDFLARE_HEADERS === "true",
    vercel: !isRailwayRuntime(env),
  };
}
