import type { DexModule } from "../registry";
import { uniswapV4RhcDescriptor } from "./descriptor";

/**
 * Server registration of Uniswap v4 on Robinhood Chain (E2-alias). Lazy adapter so other routes
 * do not bundle it. Listing is served on the module (`listPositions`); the live open/close path
 * stays on the dedicated `/api/rhc-univ4-open` and `/api/rhc-univ4-exit` routes.
 *
 * `enabled` is true only for the read-only `positions` op. Every generic write op (and
 * `performance`) 404s, in every deploy target, without loading the adapter. Production
 * `RHC_UNIV4_*` flags are not touched.
 */
export const uniswapV4RhcModule: DexModule = Object.freeze({
  descriptor: uniswapV4RhcDescriptor,
  adapter: async () => (await import("./adapter.server")).createUniswapV4RhcAdapter(),
  enabled: (op) => op === "positions",
});
