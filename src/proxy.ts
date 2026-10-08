import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { appSubdomainRewritePath, isAppSubdomainHost } from "@/lib/app-host";

/**
 * Next.js 16 Proxy (formerly middleware). Host-based App rewrite only.
 *
 * On a future custom domain, `app.<domain>/<path>` → `/app/<path>`.
 * No effect on `*.vercel.app` (including sofinance-alpha.vercel.app).
 * `/api/*` is excluded by the matcher and by `appSubdomainRewritePath`.
 *
 * To enable: attach apex + `app.` hostnames in Vercel. See README.
 */
export function proxy(request: NextRequest) {
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
    "/((?!api|_next/static|_next/image|favicon.ico|favicon.svg|.*\\.png$|.*\\.ico$|.*\\.svg$).*)",
  ],
};
