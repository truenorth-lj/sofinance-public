import type { DexModule } from "../registry";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { rhcScanClientIp, rhcScanRateLimited } from "@/lib/rhc-scan-rate-limit";
import { uniswapV4RhcDescriptor } from "./descriptor";

/**
 * Server registration of Uniswap v4 on Robinhood Chain (E2-alias). Lazy adapter so other routes
 * do not bundle it. Listing is served on the module (`listPositions`) when trading is on; the live
 * open/close path stays on the dedicated `/api/rhc-univ4-open` and `/api/rhc-univ4-exit` routes.
 *
 * `enabled("positions")` follows `isRhcUniv4TradingEnabled` (same gate as GET `/api/rhc-univ4-positions`).
 * Flag values and definitions are not changed. Every generic write op (and `performance`) 404s, in
 * every deploy target, without loading the adapter. The positions op also shares the dedicated
 * route's `rhcScanRateLimited` per-IP bucket and 429s (Retry-After 60) without loading the adapter.
 */
export const uniswapV4RhcModule: DexModule = Object.freeze({
  descriptor: uniswapV4RhcDescriptor,
  adapter: async () => (await import("./adapter.server")).createUniswapV4RhcAdapter(),
  enabled: (op) => op === "positions" && isRhcUniv4TradingEnabled(),
  rateLimited: (op, request) => op === "positions" && rhcScanRateLimited(rhcScanClientIp(request)),
});
