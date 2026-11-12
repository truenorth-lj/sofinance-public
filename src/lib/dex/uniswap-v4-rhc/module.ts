import type { DexModule } from "../registry";
import { uniswapV4RhcDescriptor } from "./descriptor";

/**
 * Server registration of Uniswap v4 on Robinhood Chain (E2-register). Lazy adapter so other routes
 * do not bundle it. Discovery, positions listing, and the live open/close path stay on the existing
 * dedicated routes and sources.
 *
 * `enabled` is always false: the generic `/api/dex/[dex]/[op]` route 404s for every op, in every
 * deploy target, without loading the adapter. Dedicated `POST /api/rhc-univ4-open` and
 * `POST /api/rhc-univ4-exit` are not gated by this hook. Production `RHC_UNIV4_*` flags are not
 * touched.
 */
export const uniswapV4RhcModule: DexModule = Object.freeze({
  descriptor: uniswapV4RhcDescriptor,
  adapter: async () => (await import("./adapter.server")).createUniswapV4RhcAdapter(),
  enabled: () => false,
});
