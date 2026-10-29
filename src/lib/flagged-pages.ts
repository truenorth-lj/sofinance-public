import { type DeployTarget, deployTarget, isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";

/**
 * Pages hidden behind a code flag. The page itself calls `notFound()`, but the root layout streams a
 * Suspense boundary first, so a dynamic page's `notFound()` renders the 404 UI with HTTP 200. The proxy
 * uses this to rewrite these paths to a missing route so production answers a real 404.
 */
export const FLAG_OFF_NOT_FOUND_PATH = "/_flag-off-not-found";

export function isFlaggedOffPage(pathname: string, target: DeployTarget = deployTarget()): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/app/rhc" || path.startsWith("/app/rhc/")) return !isRhcUniv4TradingEnabled(target);
  return false;
}
