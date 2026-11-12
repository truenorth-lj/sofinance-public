import type { DexModule } from "../registry";
import { raydiumClmmDescriptor } from "./descriptor";

/**
 * Server registration of Raydium CLMM (E3). Lazy adapter so other routes do not bundle it.
 * `enabled` is always false: the generic `/api/dex/[dex]/[op]` route 404s for every Raydium
 * op, in every deploy target, without loading the adapter. Dedicated prepare routes stay
 * the only write path. Listing stays on the inline `/app` wallet scan.
 */
export const raydiumClmmModule: DexModule = Object.freeze({
  descriptor: raydiumClmmDescriptor,
  adapter: async () => (await import("./adapter.server")).createRaydiumClmmAdapter(),
  enabled: () => false,
});
