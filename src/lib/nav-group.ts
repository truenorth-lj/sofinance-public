/**
 * Pathname → site header group. This is the single source of truth.
 *
 * App: `/pools`, `/pools/…`, `/app`, `/app/…` (pool list, public pool pages, and the product UI).
 * Anything else, including unlisted routes and the root 404, defaults to marketing.
 */
export type NavGroup = "marketing" | "app";

export function navGroup(pathname: string | null | undefined): NavGroup {
  const path = normalizePath(pathname);
  if (path === "/pools" || path.startsWith("/pools/")) return "app";
  if (path === "/app" || path.startsWith("/app/")) return "app";
  return "marketing";
}

function normalizePath(pathname: string | null | undefined): string {
  const raw = (pathname ?? "/").trim() || "/";
  const noQuery = raw.split("?")[0]?.split("#")[0] || "/";
  if (noQuery.length > 1 && noQuery.endsWith("/")) return noQuery.slice(0, -1);
  return noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
}
