import type { DexModule } from "../registry";
import { meteoraDlmmDescriptor } from "./descriptor";

/**
 * Server registration of Meteora DLMM. The adapter (engine, RPC, Jupiter) loads lazily so routes that never touch
 * Meteora do not bundle it. No `poolSource` here yet: the pool scan moves behind the registry in PR12.
 */
export const meteoraDlmmModule: DexModule = Object.freeze({
  descriptor: meteoraDlmmDescriptor,
  adapter: async () => (await import("./adapter.server")).createMeteoraDlmmAdapter(),
  poolDailyApr: async (poolId) => (await import("./daily-apr.server")).meteoraPoolDailyApr(poolId),
});
