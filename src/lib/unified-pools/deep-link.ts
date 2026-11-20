import { uiFor } from "@/lib/dex/ui";
import { buildOpenPositionPath } from "@/lib/public-urls";

/** `/app/rhc` (the old Robinhood Chain page) now redirects here: the pools page opens the SPCX/SPCXon pool's MetaMask flow. */
const rhcDefaultPool = uiFor("uniswap-v4-rhc").defaultOpenPoolId;
if (!rhcDefaultPool) throw new Error("Default RHC pool is not configured");
export const RHC_DEEP_LINK = buildOpenPositionPath(rhcDefaultPool);

/** Old `/app?openPool=<id>` links (the pool list was on /app): where they now open, or null without a pool. */
export function openPoolRedirect(openPool: string | null | undefined): string | null {
  const poolId = openPool?.trim();
  return poolId ? buildOpenPositionPath(poolId) : null;
}

/** Where an old page path (plus its query string) now lives, or null. */
export function unifiedAppRedirect(pathname: string, search = ""): string | null {
  if (pathname === "/app/rhc") return RHC_DEEP_LINK;
  if (pathname === "/app") {
    const pools = openPoolRedirect(new URLSearchParams(search).get("openPool"));
    return pools ?? `/app/portfolio${search ? `?${search.replace(/^\?/, "")}` : ""}`;
  }
  return null;
}
