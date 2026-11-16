import type { PublicPoolReads } from "../public-pool-read";
import type { DexModule } from "../registry";
import type { NativeEvmPositionReads } from "../evm-position-read";
import type { NativeEvmLiquidity } from "../evm-liquidity";
import { isRhcUniv4TradingEnabled, isRhcUniv4TxBuildEnabled, isRhcUniv4DiscoveryEnabled, isRhcApr7dEnabled } from "@/lib/protocol-flags";
import { rhcScanClientIp, rhcScanRateLimited } from "@/lib/rhc-scan-rate-limit";
import { uniswapV4RhcDescriptor } from "./descriptor";
import { RhcOpenRequestSchema, RhcExitRequestSchema } from "./liquidity-input";
import { parsePositionIds, RHC_SCAN_FAILED_MESSAGE } from "./position-input";

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
  publicPoolReads: Object.freeze({
    snapshotBacked: true, rangeAprUnavailableMessage: "RHC range APR unavailable",
    discovery: Object.freeze({ enabled: () => isRhcUniv4DiscoveryEnabled(), read: async () => (await import("@/lib/rhc-snapshot")).getRhcPoolsSnapshot() }),
    rangeApr: Object.freeze({
      enabled: () => isRhcApr7dEnabled(),
      read: async (poolId: string) => {
        const { isAllowlistedRhcPool } = await import("@/lib/rhc-range-apr");
        if (!isAllowlistedRhcPool(poolId)) return null;
        return (await import("@/lib/rhc-snapshot")).getRhcAprSnapshot(poolId);
      },
    }),
  } satisfies PublicPoolReads),
  evmPositionReads: Object.freeze({
    enabled: () => isRhcUniv4TradingEnabled(),
    parseIds: parsePositionIds,
    scanFailedMessage: RHC_SCAN_FAILED_MESSAGE,
    scan: async (wallet, options) => (await import("./position-scan.server")).scanRhcPositions(wallet, options),
    values: async (ids) => (await import("./position-values.server")).rhcPositionValues(ids),
  } satisfies NativeEvmPositionReads),
  evmLiquidity: Object.freeze({
    enabled: isRhcUniv4TxBuildEnabled,
    schemas: Object.freeze({ open: RhcOpenRequestSchema, exit: RhcExitRequestSchema }),
    open: async (command) => (await import("./open.server")).runRhcUniv4Open(command),
    exit: async (command) => (await import("./exit.server")).runRhcUniv4Exit(command),
  } satisfies NativeEvmLiquidity),
  adapter: async () => (await import("./adapter.server")).createUniswapV4RhcAdapter(),
  enabled: (op) => op === "positions" && isRhcUniv4TradingEnabled(),
  rateLimited: (op, request) => op === "positions" && rhcScanRateLimited(rhcScanClientIp(request)),
});
