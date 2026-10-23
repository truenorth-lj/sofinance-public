/**
 * First-party PostHog relay.
 *
 * The browser sends analytics to `/lumen/*` on our own domain; `next.config.ts` rewrites
 * that path to PostHog. Ad blockers and privacy shields block `*.posthog.com` directly,
 * which silently dropped every event for those visitors. The path is deliberately
 * non-obvious (not `/ingest` or `/posthog`), since blocklists target those names too.
 *
 * Keep `POSTHOG_RELAY_PATH` in sync with the literal in `src/proxy.ts`'s matcher
 * (Next.js requires that matcher to be a static string).
 */
export const POSTHOG_RELAY_PATH = "/lumen";

const DEFAULT_INGEST_HOST = "https://us.i.posthog.com";

export type PosthogUpstream = { ingest: string; assets: string; ui: string };

/** Upstream PostHog hosts. `NEXT_PUBLIC_POSTHOG_HOST` may pick another region; default is US cloud. */
export function posthogUpstream(host?: string): PosthogUpstream {
  const ingest = (host?.trim() || DEFAULT_INGEST_HOST).replace(/\/+$/, "");
  const region = /^https:\/\/(us|eu)\.i\.posthog\.com$/.exec(ingest)?.[1];
  return {
    ingest,
    assets: region ? `https://${region}-assets.i.posthog.com` : ingest,
    ui: `https://${region ?? "us"}.posthog.com`,
  };
}

/** Next.js rewrites for the relay. Static assets and remote config live on the assets host. */
export function posthogRelayRewrites(host?: string) {
  const { ingest, assets } = posthogUpstream(host);
  return [
    { source: `${POSTHOG_RELAY_PATH}/static/:path*`, destination: `${assets}/static/:path*` },
    { source: `${POSTHOG_RELAY_PATH}/array/:path*`, destination: `${assets}/array/:path*` },
    { source: `${POSTHOG_RELAY_PATH}/:path*`, destination: `${ingest}/:path*` },
  ];
}

export function isPosthogRelayPath(pathname: string): boolean {
  return pathname === POSTHOG_RELAY_PATH || pathname.startsWith(`${POSTHOG_RELAY_PATH}/`);
}
