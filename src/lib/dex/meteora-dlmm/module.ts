import { METEORA_CRON_POLICY } from "./cron-policy";
import type { PublicPoolReads } from "../public-pool-read";
import { isMeteoraDlmmDiscoveryEnabled } from "@/lib/protocol-flags";
import type { DexModule } from "../registry";
import { meteoraDlmmDescriptor } from "./descriptor";

/**
 * Server registration of Meteora DLMM. The adapter (engine, RPC, Jupiter) loads lazily so routes that never touch
 * Meteora do not bundle it. The pool scan source is also loaded only when requested.
 */
export const meteoraDlmmModule: DexModule = Object.freeze({
  descriptor: meteoraDlmmDescriptor,
  poolCron: Object.freeze({
    policy: METEORA_CRON_POLICY,
    publish: async input => (await import("./cron.server")).publishMeteoraFeed(input.store, input.lease, input.seedPairs, input.fetcher, input.signal),
    refresh: async input => (await import("./cron.server")).refreshMeteoraLane({ ...input, poolTimeoutMs: input.poolTimeoutMs ?? METEORA_CRON_POLICY.poolTimeoutMs }),
  } satisfies NonNullable<DexModule["poolCron"]>),
  poolSource: Object.freeze({ order: 1, load: async () => (await import("@/lib/pool-sources/meteora")).meteoraPoolSource }),
  publicPoolReads: Object.freeze({
    snapshotBacked: false, rangeAprUnavailableMessage: "Meteora range APR unavailable",
    discovery: Object.freeze({ enabled: () => isMeteoraDlmmDiscoveryEnabled(), read: async () => (await import("@/lib/meteora-pairs")).discoverMeteoraPairs() }),
    rangeApr: Object.freeze({
      enabled: () => isMeteoraDlmmDiscoveryEnabled(),
      read: async (poolId: string) => {
        const reader = await import("@/lib/meteora-range-apr");
        return reader.isAllowlistedMeteoraPool(poolId) ? reader.fetchMeteoraRangeApr(poolId) : null;
      },
    }),
  } satisfies PublicPoolReads),
  positionReads: Object.freeze({
    source: "meteora" as const, order: 1, protocol: meteoraDlmmDescriptor.id,
    listing: Object.freeze({
      read: async (wallet: string) => (await import("./position-reads.server")).listMeteoraWalletPositions(wallet),
      unavailableMessage: "Meteora positions are unavailable right now.",
    }),
    enabled: isMeteoraDlmmDiscoveryEnabled,
    matches: async (positionMint: string) => (await import("./position-reads.server")).matchesMeteoraPosition(positionMint),
    performance: async (...args: Parameters<NonNullable<DexModule["positionReads"]>["performance"]>) => (await import("./position-reads.server")).readMeteoraPerformance(...args),
    range: async (positionMint: string) => (await import("./position-reads.server")).readMeteoraRange(positionMint),
  }),
  adapter: async () => (await import("./adapter.server")).createMeteoraDlmmAdapter(),
  poolDailyApr: async (poolId) => (await import("./daily-apr.server")).meteoraPoolDailyApr(poolId),
  recordDailyTvl: async (input) => (await import("./daily-tvl.server")).recordMeteoraDailyTvl(input),
});
