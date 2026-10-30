import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";

/** `/app/rhc` (the old Robinhood Chain page) now redirects here: `/app` opens the SPCX/SPCXon pool's MetaMask flow. */
export const RHC_DEEP_LINK = `/app?openPool=${UNIV4_RHC_ALLOWLISTED_POOLS[0]!.poolId}`;

/** The pool list on `/app` (section `#pools`). */
export const APP_POOLS_PATH = "/app#pools";

/** Query parameters a retired page forwards to `/app` (campaign attribution only). */
const FORWARDED_PARAMS = ["ref", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

/**
 * `/app/rwa-pairs` (retired 2026-10-30; the Solana pairs are in the `/app` pool list):
 * `?pool=<id>&open=1` (old open-position deep link) → `/app?openPool=<id>#pools`, anything else → `/app#pools`.
 * `ref` / `utm_*` are kept so campaign links still attribute.
 */
export function rwaPairsRedirect(search: string | URLSearchParams = ""): string {
  const query = typeof search === "string" ? new URLSearchParams(search) : search;
  const out = new URLSearchParams();
  const pool = query.get("pool")?.trim();
  if (pool && query.get("open") === "1") out.set("openPool", pool);
  for (const key of FORWARDED_PARAMS) {
    const value = query.get(key);
    if (value) out.set(key, value);
  }
  const qs = out.toString();
  return `/app${qs ? `?${qs}` : ""}#pools`;
}

/** Where an old page path now lives in `/app`, or null. */
export function unifiedAppRedirect(pathname: string, search: string | URLSearchParams = ""): string | null {
  if (pathname === "/app/rhc") return RHC_DEEP_LINK;
  if (pathname === "/app/rwa-pairs" || pathname === "/app/rwa-pairs/") return rwaPairsRedirect(search);
  return null;
}
