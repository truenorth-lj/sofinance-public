/** Path prefix for the product UI after the marketing landing took `/`. */
export const APP_PATH = "/app";

export const APP_ROUTES = {
  home: APP_PATH,
  plan: `${APP_PATH}/plan`,
  rwaPairs: `${APP_PATH}/rwa-pairs`,
  positionPerformance: `${APP_PATH}/position-performance`,
  ai: `${APP_PATH}/ai`,
} as const;

export const SIGN_PATH = `${APP_PATH}/sign`;

/** Canonical production origin. Used by sitemap/robots when NEXT_PUBLIC_APP_URL is unset. */
export const CANONICAL_SITE_URL = "https://sofinancelab.xyz";

export function getPublicBaseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) {
    const host = vercel.replace(/\/$/, "");
    return host.startsWith("http") ? host : `https://${host}`;
  }

  return "";
}

/** Origin for SEO metadata. Prefers NEXT_PUBLIC_APP_URL; never VERCEL_URL (preview hosts). */
export function getCanonicalSiteUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return CANONICAL_SITE_URL;
}

export function buildSignPath(signToken: string): string {
  return `${SIGN_PATH}/${signToken}`;
}

/** Absolute (or root-relative) URL emitted by MCP `prepare_*` tools. */
export function buildSignUrl(signToken: string): string {
  const path = buildSignPath(signToken);
  const base = getPublicBaseUrl();
  return base ? `${base}${path}` : path;
}

export function buildOpenPositionPath(poolId: string): string {
  return `${APP_ROUTES.rwaPairs}?pool=${encodeURIComponent(poolId)}&open=1`;
}

/** Deep link that opens the add-liquidity modal on /app/rwa-pairs. */
export function buildOpenPositionUrl(poolId: string): string {
  const path = buildOpenPositionPath(poolId);
  const base = getPublicBaseUrl();
  return base ? `${base}${path}` : path;
}

/** Plan page for a specific pool. `pair` is a display label only. */
export function buildPlanPath(input: { poolId: string; pair?: string }): string {
  const params = new URLSearchParams({ pool: input.poolId });
  if (input.pair) params.set("pair", input.pair);
  return `${APP_ROUTES.plan}?${params}`;
}

/** User-facing documentation (public site, English). */
export const DOCS_PATH = "/docs";

export const DOCS_ROUTES = {
  home: DOCS_PATH,
  gettingStarted: DOCS_PATH,
  yieldAndApr: `${DOCS_PATH}/yield-and-apr`,
  risks: `${DOCS_PATH}/risks`,
  fees: `${DOCS_PATH}/fees`,
  withdraw: `${DOCS_PATH}/withdraw`,
  security: `${DOCS_PATH}/security`,
} as const;

/** Long-form articles (public site, English). Add a file in `content/blog/` to publish. */
export const BLOG_PATH = "/blog";

export const BLOG_ROUTES = {
  home: BLOG_PATH,
} as const;

export function blogArticlePath(slug: string): string {
  return `${BLOG_PATH}/${slug}`;
}

/** Legal pages (public site, English). */
export const LEGAL_ROUTES = {
  terms: "/terms",
} as const;
