import type { ProtocolPoolListing, ProtocolPoolRangeApr } from "@/lib/protocol-pool-types";

/** Existing public discovery/APR surfaces, separate from generic trading and cron PoolSource admission. */
export type PublicPoolReadPolicy = Readonly<{ snapshotBacked: boolean; rangeAprUnavailableMessage: string }>;
export type PublicPoolReads = PublicPoolReadPolicy & {
  discovery: { enabled: () => boolean; read: () => Promise<ProtocolPoolListing> };
  rangeApr: { enabled: () => boolean; read: (poolId: string) => Promise<ProtocolPoolRangeApr | null> };
};
