import type { PublicPoolReads } from "../public-pool-read";
import { isOrcaPositionsEnabled, isOrcaDiscoveryEnabled } from "@/lib/protocol-flags";
import type { DexModule } from "../registry";
import { orcaWhirlpoolDescriptor } from "./descriptor";

/**
 * Server registration of Orca Whirlpool (E1). Read-only adapter, lazy so other routes do not
 * bundle it. No `poolSource` / `poolDailyApr` / `recordDailyTvl`: discovery stays on the existing
 * flag-gated `/api/protocol-pools` path.
 *
 * `enabled` is always false in this series: the generic `/api/dex/[dex]/[op]` route 404s for every
 * Orca op, in every deploy target, without loading the adapter. Production discovery/positions
 * flags stay off separately. This is stricter than "positions follow the preview flag", so the
 * unified positions UI cannot gain Orca rows in preview either (PM, 2026-11-12).
 */
export const orcaWhirlpoolModule: DexModule = Object.freeze({
  descriptor: orcaWhirlpoolDescriptor,
  publicPoolReads: Object.freeze({
    snapshotBacked: false, rangeAprUnavailableMessage: "Orca range APR unavailable",
    discovery: Object.freeze({ enabled: () => isOrcaDiscoveryEnabled(), read: async () => (await import("@/lib/orca-pairs")).discoverOrcaPairs() }),
    rangeApr: Object.freeze({
      enabled: () => isOrcaDiscoveryEnabled(),
      read: async (poolId: string) => {
        const reader = await import("@/lib/orca-range-apr");
        return reader.isAllowlistedOrcaPool(poolId) ? reader.fetchOrcaRangeApr(poolId) : null;
      },
    }),
  } satisfies PublicPoolReads),
  positionReads: Object.freeze({
    source: "orca" as const, order: 0, protocol: orcaWhirlpoolDescriptor.id,
    listing: Object.freeze({
      read: async (wallet: string) => (await import("./position-reads.server")).listOrcaWalletPositions(wallet),
      unavailableMessage: "Orca positions are unavailable right now.",
    }),
    enabled: isOrcaPositionsEnabled,
    matches: async (positionMint: string) => (await import("./position-reads.server")).matchesOrcaPosition(positionMint),
    performance: async (...args: Parameters<NonNullable<DexModule["positionReads"]>["performance"]>) => (await import("./position-reads.server")).readOrcaPerformance(...args),
    range: async (positionMint: string) => (await import("./position-reads.server")).readOrcaRange(positionMint),
  }),
  adapter: async () => (await import("./adapter.server")).createOrcaWhirlpoolAdapter(),
  enabled: () => false,
});
