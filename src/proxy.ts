import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { FLAG_OFF_NOT_FOUND_PATH, isFlaggedOffPage } from "@/lib/flagged-pages";
import { appSubdomainRewritePath, isAppSubdomainHost, trailingSlashRedirectPath } from "@/lib/app-host";
import { unifiedAppRedirect } from "@/lib/unified-pools/deep-link";
import { REGION_NOTICE_COOKIE, REGION_NOTICE_COOKIE_MAX_AGE, regionNoticeForCountry } from "@/lib/region-notice";

/**
 * Next.js 16 Proxy (formerly middleware). Host-based App rewrite, plus the region-notice flag cookie
 * (notice only; it never blocks or redirects — see src/lib/region-notice.ts).
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
  const rewritePath = isAppSubdomainHost(host) ? appSubdomainRewritePath(request.nextUrl.pathname) : null;
  if (isFlaggedOffPage(rewritePath ?? request.nextUrl.pathname)) {
    // Real 404 status for flag-off pages (a dynamic page's notFound() streams as 200 under the root Suspense).
    const url = request.nextUrl.clone();
    url.pathname = FLAG_OFF_NOT_FOUND_PATH;
    return withRegionNotice(request, NextResponse.rewrite(url));
  }
  // Old pages merged into `/app` (flag-off pages above stay 404). A real 307, not a streamed client redirect.
  const moved = unifiedAppRedirect(rewritePath ?? request.nextUrl.pathname, request.nextUrl.search);
  if (moved) return withRegionNotice(request, NextResponse.redirect(new URL(moved, request.url), 307));
  if (!rewritePath) {
    return withRegionNotice(request, NextResponse.next());
  }

  const url = request.nextUrl.clone();
  url.pathname = rewritePath;
  return withRegionNotice(request, NextResponse.rewrite(url));
}

/** Sets (or clears) the readable notice flag from Vercel's geo header. Never changes status or path. */
function withRegionNotice(request: NextRequest, response: NextResponse) {
  const show = regionNoticeForCountry(request.headers.get("x-vercel-ip-country"));
  const hasFlag = request.cookies.get(REGION_NOTICE_COOKIE)?.value === "1";
  if (show && !hasFlag) {
    response.cookies.set(REGION_NOTICE_COOKIE, "1", {
      path: "/", maxAge: REGION_NOTICE_COOKIE_MAX_AGE, sameSite: "lax", secure: request.nextUrl.protocol === "https:",
    });
  } else if (show === false && hasFlag) {
    response.cookies.delete(REGION_NOTICE_COOKIE);
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!api|lumen|_next/static|_next/image|favicon.ico|favicon.svg|sitemap.xml|robots.txt|.*\\.png$|.*\\.ico$|.*\\.svg$).*)",
  ],
};
