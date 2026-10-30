import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";

/** `/app/rhc` (the old Robinhood Chain page) now redirects here: `/app` opens the SPCX/SPCXon pool's MetaMask flow. */
export const RHC_DEEP_LINK = `/app?openPool=${UNIV4_RHC_ALLOWLISTED_POOLS[0]!.poolId}`;

/** Where an old page path now lives in `/app`, or null. */
export function unifiedAppRedirect(pathname: string): string | null {
  return pathname === "/app/rhc" ? RHC_DEEP_LINK : null;
}
