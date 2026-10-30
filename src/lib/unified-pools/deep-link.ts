import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";

/** The pools page (Solana + Robinhood Chain); `?openPool=<id>` opens that pool. */
export const POOLS_PAGE_PATH = "/app/rwa-pairs";

/** Link that opens one pool's Open position flow on the pools page. */
export function poolsPageOpenPath(poolId: string): string {
  return `${POOLS_PAGE_PATH}?openPool=${encodeURIComponent(poolId)}`;
}

/** `/app/rhc` (the old Robinhood Chain page) now redirects here: the pools page opens the SPCX/SPCXon pool's MetaMask flow. */
export const RHC_DEEP_LINK = poolsPageOpenPath(UNIV4_RHC_ALLOWLISTED_POOLS[0]!.poolId);

/** Old `/app?openPool=<id>` links (the pool list was on /app): where they now open, or null without a pool. */
export function openPoolRedirect(openPool: string | null | undefined): string | null {
  const poolId = openPool?.trim();
  return poolId ? poolsPageOpenPath(poolId) : null;
}

/** Where an old page path (plus its query string) now lives, or null. */
export function unifiedAppRedirect(pathname: string, search = ""): string | null {
  if (pathname === "/app/rhc") return RHC_DEEP_LINK;
  if (pathname === "/app") return openPoolRedirect(new URLSearchParams(search).get("openPool"));
  return null;
}
