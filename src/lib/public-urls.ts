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
