import { uiFor } from "@/lib/dex/ui";

/** The pools page (Solana + Robinhood Chain); `?openPool=<id>` opens that pool. */
const POOLS_PAGE_PATH = "/app/rwa-pairs";

/** Link that opens one pool's Open position flow on the pools page. */
function poolsPageOpenPath(poolId: string): string {
  return `${POOLS_PAGE_PATH}?openPool=${encodeURIComponent(poolId)}`;
}

/** `/app/rhc` (the old Robinhood Chain page) now redirects here: the pools page opens the SPCX/SPCXon pool's MetaMask flow. */
const rhcDefaultPool = uiFor("uniswap-v4-rhc").defaultOpenPoolId;
if (!rhcDefaultPool) throw new Error("Default RHC pool is not configured");
export const RHC_DEEP_LINK = poolsPageOpenPath(rhcDefaultPool);

/** Old `/app?openPool=<id>` links (the pool list was on /app): where they now open, or null without a pool. */
export function openPoolRedirect(openPool: string | null | undefined): string | null {
  const poolId = openPool?.trim();
  return poolId ? poolsPageOpenPath(poolId) : null;
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
