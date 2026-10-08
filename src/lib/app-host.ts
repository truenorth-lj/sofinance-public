/**
 * Host-based App subdomain rewrite.
 *
 * After a custom domain is attached (e.g. sofinance.xyz + app.sofinance.xyz),
 * requests to `app.<domain>/<path>` are rewritten to `/app/<path>` so the
 * product UI can live on the subdomain while the apex stays the landing page.
 *
 * `*.vercel.app` hosts are ignored — Hobby deployments cannot use a real
 * `app.` subdomain, so sofinance-alpha.vercel.app is unaffected.
 *
 * `/api/*` is never rewritten. Enable by adding the `app.` hostname in Vercel;
 * no other config flag is required.
 */

export function hostnameFromHost(host: string | null | undefined): string {
  if (!host) return "";
  return host.split(":")[0]?.toLowerCase() ?? "";
}

export function isAppSubdomainHost(host: string | null | undefined): boolean {
  const hostname = hostnameFromHost(host);
  if (!hostname) return false;
  if (hostname.endsWith(".vercel.app")) return false;
  return hostname.startsWith("app.");
}

/** Destination path for an app-subdomain request, or null to leave unchanged. */
export function appSubdomainRewritePath(pathname: string): string | null {
  if (pathname === "/api" || pathname.startsWith("/api/")) return null;
  if (pathname.startsWith("/_next/")) return null;
  if (pathname === "/app" || pathname.startsWith("/app/")) return null;
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return null;
  if (pathname === "/") return "/app";
  return `/app${pathname}`;
}
