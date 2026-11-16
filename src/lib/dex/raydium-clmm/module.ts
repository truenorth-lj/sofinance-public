import type { DexModule } from "../registry";
import { raydiumClmmDescriptor } from "./descriptor";

/**
 * Server registration of Raydium CLMM (E3). Lazy adapter so other routes do not bundle it.
 * `enabled` is always false: the generic `/api/dex/[dex]/[op]` route 404s for every Raydium
 * op, in every deploy target, without loading the adapter. Existing app/MCP transports
 * use the lazy full-build binding below. Listing stays on the inline `/app` wallet scan.
 */
export const raydiumClmmModule: DexModule = Object.freeze({
  descriptor: raydiumClmmDescriptor,
  adapter: async () => (await import("./adapter.server")).createRaydiumClmmAdapter(),
  buildAdd: async (command, options) => (await import("./build-add.server")).buildRaydiumAdd(command, options),
  buildWithdrawal: async (command, preview) => (await import("./build-withdraw.server")).buildRaydiumWithdrawal(command, preview),
  enabled: () => false,
  preparePortfolio: async (input, signal) => (await import("./portfolio.server")).prepareRaydiumPortfolio(input, signal),
});
