import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { appSubdomainRewritePath, isAppSubdomainHost, trailingSlashRedirectPath } from "@/lib/app-host";
import {
  evaluateRegion,
  GEO_OVERRIDE_COOKIE,
  GEO_OVERRIDE_QUERY,
  geoOverrideAllowed,
  parseGeoOverride,
  readGeo,
  regionRestrictedBody,
} from "@/lib/restricted-regions";
import { classifyAppPath, isRegionBlockedApi, RESTRICTED_PAGE_PATH } from "@/lib/region-routes";
import { unverifiedSignTokenKind } from "@/lib/sign-token-kind";

const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

/**
 * Next.js 16 Proxy (formerly middleware).
 *
 * 1. Trailing-slash redirect for pages (`skipTrailingSlashRedirect` is on for the PostHog relay,
 *    `/lumen/*`, see src/lib/analytics/relay.ts). Not applied to `/api/*`.
 * 2. Restricted-region gate (see `src/lib/region-routes.ts`): order-building APIs answer 403 JSON and
 *    /app pages render the blocked page for visitors whose IP country/region is restricted.
 *    Withdrawal and recovery routes, /app/exit, withdrawal sign links, the landing page, /docs and
 *    /terms stay reachable.
 * 3. Host-based App rewrite: `app.<domain>/<path>` → `/app/<path>` (no effect on `*.vercel.app`).
 *    `/api/*` and the PostHog relay are never rewritten (`appSubdomainRewritePath`).
 */
export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  if (!isApiPath(pathname)) {
    const slashless = trailingSlashRedirectPath(pathname);
    if (slashless) {
      // Build a plain URL: a cloned nextUrl re-adds the trailing slash it was parsed with.
      const url = new URL(`${slashless}${request.nextUrl.search}`, request.url);
      return NextResponse.redirect(url, 308);
    }
  }

  const rewritePath = isAppSubdomainHost(request.headers.get("host")) ? appSubdomainRewritePath(pathname) : null;
  const effectivePath = rewritePath ?? pathname;

  const geo = readGeo(request.headers, { cookies: request.cookies, query: searchParams });
  const decision = evaluateRegion(geo);

  if (decision.blocked) {
    if (isRegionBlockedApi(effectivePath)) {
      return withOverrideCookie(request, NextResponse.json(regionRestrictedBody(decision), {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      }));
    }
    const appDecision = classifyAppPath(effectivePath);
    const signKind = appDecision === "sign-link" ? unverifiedSignTokenKind(effectivePath.slice("/app/sign/".length)) : null;
    if (appDecision === "block" || (appDecision === "sign-link" && signKind !== "withdraw")) {
      const url = request.nextUrl.clone();
      url.pathname = RESTRICTED_PAGE_PATH;
      url.search = "";
      return withOverrideCookie(request, NextResponse.rewrite(url, { headers: { "Cache-Control": "no-store" } }));
    }
  }

  if (rewritePath) {
    const url = request.nextUrl.clone();
    url.pathname = rewritePath;
    return withOverrideCookie(request, NextResponse.rewrite(url));
  }
  return withOverrideCookie(request, NextResponse.next());
}

/** Non-production only: `?__geo=TW` sticks for the session so client-side API calls see it too. */
function withOverrideCookie(request: NextRequest, response: NextResponse) {
  const value = request.nextUrl.searchParams.get(GEO_OVERRIDE_QUERY);
  if (value === null || !geoOverrideAllowed()) return response;
  if (value === "" || value.toLowerCase() === "off") response.cookies.delete(GEO_OVERRIDE_COOKIE);
  else if (parseGeoOverride(value)) response.cookies.set(GEO_OVERRIDE_COOKIE, value.toUpperCase(), { path: "/", sameSite: "lax", httpOnly: true });
  return response;
}

export const config = {
  matcher: [
    // `/api/*` is included for the region gate; the PostHog relay (`/lumen/*`) and static files are not.
    "/((?!lumen|_next/static|_next/image|favicon.ico|favicon.svg|sitemap.xml|robots.txt|.*\\.png$|.*\\.ico$|.*\\.svg$).*)",
  ],
};
