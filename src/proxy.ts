import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { appSubdomainRewritePath, isAppSubdomainHost, trailingSlashRedirectPath } from "@/lib/app-host";

/**
 * Next.js 16 Proxy (formerly middleware). Host-based App rewrite only.
 *
 * On a future custom domain, `app.<domain>/<path>` → `/app/<path>`.
 * No effect on `*.vercel.app`.
 * `/api/*` and the PostHog relay (`/lumen/*`, see src/lib/analytics/relay.ts) are excluded by the
 * matcher and by `appSubdomainRewritePath`.
 *
 * To enable: attach apex + `app.` hostnames in Vercel. See README.
 */
export function proxy(request: NextRequest) {
  // `skipTrailingSlashRedirect` (for the PostHog relay) disables Next's built-in redirect; keep it for pages.
  const slashless = trailingSlashRedirectPath(request.nextUrl.pathname);
  if (slashless) {
    // Build a plain URL: a cloned nextUrl re-adds the trailing slash it was parsed with.
    const url = new URL(`${slashless}${request.nextUrl.search}`, request.url);
    return NextResponse.redirect(url, 308);
  }

  const host = request.headers.get("host");
  if (!isAppSubdomainHost(host)) {
    return NextResponse.next();
  }

  const rewritePath = appSubdomainRewritePath(request.nextUrl.pathname);
  if (!rewritePath) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = rewritePath;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: [
    "/((?!api|lumen|_next/static|_next/image|favicon.ico|favicon.svg|sitemap.xml|robots.txt|.*\\.png$|.*\\.ico$|.*\\.svg$).*)",
  ],
};
