import { z } from "zod";
import type {
  DiscoverRwaPairsResult,
  RwaPairRow,
  RwaPairSortBy,
} from "./rwa-pairs";
import type { PoolRangeAprPayload } from "./range-apr/types";
import type { VolumeProfile } from "./pool-range-apr";
import type { Univ4PoolSummary } from "@sofinance/engine/protocols/uniswap-v4/discovery";
import { trustedIcon } from "@sofinance/engine/token-metadata";
import { DEFAULT_PROTOCOL, POOL_PROTOCOL_IDS, type PoolProtocolId } from "@sofinance/engine/protocols/types";
import { iconAddress, validIconAddress, type TokenIconMap, type TokenIconRow } from "./token-icons/map";

export const FEED_KEY = "raydium-clmm-rwa-v1";
export const FEED_KEY_RHC = "uniswap-v4-rhc-v1";
/** Meteora DLMM RWA pools (SCAN_DESIGN.md): its own generation, so one source failing never unpublishes another. */
export const FEED_KEY_METEORA = "meteora-dlmm-rwa-v1";
/** Solana discovery feeds, Raydium first (the primary feed: `pairs` needs it published, the others are optional). */
export const SOLANA_FEED_KEYS = [FEED_KEY, FEED_KEY_METEORA] as const;
export type SolanaFeedKey = (typeof SOLANA_FEED_KEYS)[number];
/** The protocol every row of a Solana feed must carry (`publishDiscovery` rejects a mismatch). */
export const SOLANA_FEED_PROTOCOL: Readonly<Record<SolanaFeedKey, PoolProtocolId>> = Object.freeze({
  [FEED_KEY]: "raydium-clmm",
  [FEED_KEY_METEORA]: "meteora-dlmm",
});
export const PAIRING_VERSION = "rwa-pairing-v1";
export const ALGORITHM_VERSION = "range-apr-v1";
export const SOLANA_POOL_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Uniswap v4 pool id on Robinhood Chain: 0x + 64 hex. */
export const RHC_POOL_ID = /^0x[0-9a-f]{64}$/i;
/** Any pool address the store accepts (Solana base58 or RHC 0x-hex). */
export const POOL_ID = /^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-f]{64})$/i;
/** @deprecated Alias kept for existing imports. Prefer SOLANA_POOL_ID when the chain is known. */
export const SOLANA_ONLY_POOL_ID = SOLANA_POOL_ID;
export const jobNames = ["rwa-discovery", "rwa-apr-refresh"] as const;
export type JobName = (typeof jobNames)[number];
export type Lease = { job: JobName; owner: string; epoch: number };
export type Freshness = {
  snapshotAt: string;
  chainObservedAt?: string;
  economicsObservedAt?: string;
  volumeObservedAt?: string;
  stale: boolean;
  lastAttemptStatus?: string;
};
export type StoredProfile = {
  algorithmVersion: string;
  profile: VolumeProfile;
  windowEndUtc: string;
  observedAt: string;
  /** Price-history fetch bookkeeping (RHC cron rotation); kept by `saveApr` even when the profile is not replaced. */
  fetchState?: ProfileFetchState;
};
export type ProfileFetchState = {
  lastAttemptAt: string;
  /** Consecutive failed price-history fetches (0 after a success). */
  failures: number;
  /** Trades are known up to here: the last good fetch, or a later check that found no trades in the last 24 h. */
  coveredUntil?: string;
};
export type ActivePool = {
  pair: RwaPairRow;
  metricsObservedAt: string;
  profile: StoredProfile | null;
  /**
   * When the pool's APR was last refreshed or attempted (latest of the saved snapshot and the last attempt; null
   * = never): the APR cron's oldest-first queue key. Required; the cron still falls back to the saved profile's
   * last attempt / observation if a store sends null for a pool it has a profile for (`activePoolRefreshedAt`).
   */
  refreshedAt: string | null;
};
export type AprWrite = {
  poolId: string;
  /** Owning protocol of a Solana pool (default Raydium CLMM; RHC pools are told apart by their 0x id). */
  protocol?: PoolProtocolId;
  payload: PoolRangeAprPayload | null;
  profile: StoredProfile | null;
  chainObservedAt: string | null;
  issues: string[];
};
export type DiscoveryWrite = {
  /** Feed this generation replaces (default the Raydium feed, as before). */
  feedKey?: SolanaFeedKey;
  result: DiscoverRwaPairsResult;
  sourcePages: Record<string, number>;
  poolObservedAt: Record<string, string>;
  pageCounts: number[];
  qualificationObservedAt: Record<string, string | null>;
};

export class RwaStoreError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const leaseSchema = z.object({
  job: z.enum(jobNames),
  owner: z.uuid(),
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const poolSchema = z.string().regex(POOL_ID);
const solanaPoolSchema = z.string().regex(SOLANA_POOL_ID);
const pairSchema = z
  .object({
    poolAddress: solanaPoolSchema,
    mintA: solanaPoolSchema,
    mintB: solanaPoolSchema,
    symbolA: z.string().min(1),
    symbolB: z.string().min(1),
    tvlUsd: z.number().finite().nonnegative().nullable(),
    volume24hUsd: z.number().finite().nonnegative().nullable(),
    fees24hUsd: z.number().finite().nonnegative().nullable(),
    feeRate: z.number().finite().min(0).max(1).nullable(),
    estimatedFeeAprPct: z.number().finite().nonnegative().nullable(),
  })
  .passthrough();
const timestamp = z.iso.datetime();
const discoverySchema = z.object({
  feedKey: z.enum(SOLANA_FEED_KEYS).optional(),
  result: z
    .object({
      pairs: z.array(pairSchema).max(1000),
      scannedPools: z.number().int().nonnegative(),
      pagesFetched: z.number().int().min(1).max(30),
      fetchedAt: timestamp,
      source: z.string(),
      pairingRuleSummary: z.string(),
      estimatedFeeAprLabel: z.string(),
    })
    .passthrough(),
  sourcePages: z.record(
    solanaPoolSchema,
    z.number().int().min(1).max(30),
  ),
  poolObservedAt: z.record(solanaPoolSchema, timestamp),
  pageCounts: z.array(z.number().int().min(0).max(1000)).max(30),
  qualificationObservedAt: z.record(z.string(), timestamp.nullable()),
}).refine(
  // Every row belongs to the feed's protocol (rows written before `protocol` existed are Raydium).
  (value) => value.result.pairs.every((pair) =>
    ((pair as { protocol?: string }).protocol ?? DEFAULT_PROTOCOL) === SOLANA_FEED_PROTOCOL[value.feedKey ?? FEED_KEY]),
  "Pair protocol does not match its feed",
);
const aprSchema = z.object({
  poolId: poolSchema,
  protocol: z.enum(POOL_PROTOCOL_IDS).optional(),
  payload: z
    .object({
      poolId: poolSchema,
      fetchedAt: timestamp,
      sample: z.object({ degraded: z.boolean() }).passthrough(),
      presets: z
        .array(
          z.object({
            id: z.enum(["micro", "tight", "standard", "wide"]),
            tickLower: z.number().int(),
            tickUpper: z.number().int(),
            priceLower: z.number().positive(),
            priceUpper: z.number().positive(),
            estimate: z.discriminatedUnion("status", [
              z
                .object({
                  status: z.literal("ok"),
                  aprPct: z.number().finite().nonnegative(),
                })
                .passthrough(),
              z.object({
                status: z.literal("unavailable"),
                reason: z.string(),
              }),
            ]),
          }),
        )
        .min(1)
        .max(4),
      referenceCapitalUsd: z.number().positive(),
      model: z.object({ bins: z.array(z.unknown()).max(5000) }).passthrough(),
    })
    .passthrough()
    .nullable(),
  profile: z
    .object({
      algorithmVersion: z.literal(ALGORITHM_VERSION),
      profile: z
        .object({
          economics: z.object({}).passthrough(),
          candles: z.array(z.unknown()).max(200).nullable(),
        })
        .passthrough(),
      windowEndUtc: timestamp,
      observedAt: timestamp,
      fetchState: z.object({ lastAttemptAt: timestamp, failures: z.number().int().min(0), coveredUntil: timestamp.optional() }).optional(),
    })
    .nullable(),
  chainObservedAt: timestamp.nullable(),
  issues: z.array(z.string().max(500)).max(20),
}).refine(
  (value) => !value.payload || presetCountAllowed(value.poolId, value.protocol, value.payload.presets.length),
  "Unexpected preset count",
).refine(
  // A protocol, when given, matches the pool id's chain.
  (value) => !value.protocol || (value.protocol === "uniswap-v4-rhc") === /^0x/.test(value.poolId),
  "Protocol does not match pool id",
);

/**
 * Raydium serves 4 presets (micro/tight/standard/wide); RHC omits Tight (below the ±10-tick minimum); Meteora DLMM
 * serves 1–4, because presets that collapse to the same bin width on a wide bin step are dropped (SCAN_DESIGN.md §5).
 */
export function presetCountAllowed(poolId: string, protocol: PoolProtocolId | undefined, count: number): boolean {
  if (/^0x/.test(poolId)) return count === 3;
  if (protocol === "meteora-dlmm") return count >= 1 && count <= 4;
  return count === 4;
}

/** Icon rows from the daily refresh. Re-checked against `ICON_HOSTS` here so no caller can store an off-list link. */
export const tokenIconWriteSchema = z.array(z.object({
  chain: z.enum(["solana", "robinhood"]),
  address: z.string().max(64),
  image: z.string().max(1024),
  source: z.enum(["jupiter", "raydium", "dexscreener", "geckoterminal", "manual"]),
}).refine((row) => validIconAddress(row.chain, row.address) && row.address === iconAddress(row.chain, row.address)
  && trustedIcon(row.image) === row.image, "Untrusted token icon")).max(500);
export type TokenIconWrite = TokenIconRow[];

/**
 * One row per allowlisted RHC pool from the cron: the full read-only pool summary (StateView/hook checks + one
 * batched indexer call for TVL / 24h volume). Served back by `rhcPools` so the page never calls RPC or indexers.
 */
export type RhcRosterRow = { poolId: string; summary: Univ4PoolSummary };
const rhcRosterSchema = z.array(z.object({
  poolId: z.string().regex(RHC_POOL_ID),
  summary: z.object({ protocol: z.literal("uniswap-v4-rhc"), poolId: z.string().regex(RHC_POOL_ID) }).passthrough(),
}).refine((row) => row.poolId.toLowerCase() === row.summary.poolId.toLowerCase(), "Pool id mismatch")).min(1).max(32);

/** Feed list of a read: distinct, Raydium first. */
const solanaFeedKeysSchema = z.array(z.enum(SOLANA_FEED_KEYS)).min(1).max(SOLANA_FEED_KEYS.length)
  .refine((keys) => keys[0] === FEED_KEY && new Set(keys).size === keys.length, "Raydium feed first, no duplicates");

export const storeRequestSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("pairs"),
    minTvl: z.number().finite().min(0).max(1e12),
    maxPages: z.number().int().min(1).max(30),
    sortBy: z.enum(["estimatedFeeApr", "tvl", "volume24h"]),
    /** Solana feeds to merge, primary first (default the Raydium feed only, as before). */
    feedKeys: solanaFeedKeysSchema.optional(),
  }),
  z.object({ op: z.literal("apr"), poolId: poolSchema }),
  z.object({
    op: z.literal("history"),
    poolId: poolSchema,
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({
    op: z.literal("claim"),
    job: z.enum(jobNames),
    force: z.boolean().optional(),
  }),
  z.object({ op: z.literal("renew"), lease: leaseSchema }),
  z.object({
    op: z.literal("finish"),
    lease: leaseSchema,
    processed: z.number().int().min(0).max(1000).default(0),
    outcome: z.enum(["ok", "partial", "error"]),
    issues: z.array(z.string().max(500)).max(20),
  }),
  z.object({
    op: z.literal("publishDiscovery"),
    lease: leaseSchema,
    data: z.custom<DiscoveryWrite>(
      (value) => discoverySchema.safeParse(value).success,
    ),
  }),
  z.object({ op: z.literal("activePools"), feedKeys: solanaFeedKeysSchema.optional() }),
  z.object({
    op: z.literal("saveApr"),
    lease: leaseSchema,
    data: z.custom<AprWrite>((value) => aprSchema.safeParse(value).success),
  }),
  z.object({ op: z.literal("prepareDaily"), lease: leaseSchema, includeRhc: z.boolean().optional(),
    feedKeys: solanaFeedKeysSchema.optional() }),
  z.object({ op: z.literal("ensureRhcRoster"), lease: leaseSchema, data: rhcRosterSchema }),
  z.object({ op: z.literal("rhcPools") }),
  z.object({ op: z.literal("saveTokenIcons"), lease: leaseSchema, data: tokenIconWriteSchema }),
]);
type ParsedStoreRequest = z.infer<typeof storeRequestSchema>;
export type StoreOperation = ParsedStoreRequest["op"];
/** Mapped union preserves the operation/result relationship through generic dispatch. */
export type StoreRequest<K extends StoreOperation = StoreOperation> = {
  [P in K]: Extract<ParsedStoreRequest, { op: P }>;
}[K];
export type PairOptions = {
  minTvl: number;
  maxPages: number;
  sortBy: RwaPairSortBy;
};
/** `tokenIcons` is absent from stores that predate it; readers fall back (see `iconFor`). */
export type SnapshotPairs = DiscoverRwaPairsResult & {
  freshness: Freshness;
  tokenIcons?: TokenIconMap;
  /** Per-feed publish time when more than one feed was read (a secondary feed that never published is absent). */
  feeds?: Partial<Record<SolanaFeedKey, { publishedAt: string; stale: boolean; pools: number }>>;
};
export type SnapshotApr = PoolRangeAprPayload & { freshness: Freshness };

export type SnapshotHistory = {
  poolId: string;
  timezone: "Asia/Taipei";
  points: Array<{
    date: string; capturedAt: string | null; status: string;
    poolFeeAprPct: number | null; highestRangeAprPct: number | null; highestRangeId: string | null;
    presets: PoolRangeAprPayload["presets"]; referenceCapitalUsd: number;
    algorithmVersion: string; sample: Partial<PoolRangeAprPayload["sample"]>; reason: string | null;
  }>;
};
export type StoreResultMap = {
  pairs: SnapshotPairs;
  apr: SnapshotApr;
  history: SnapshotHistory;
  activePools: ActivePool[];
  claim: Lease | null;
  renew: boolean;
  finish: boolean;
  publishDiscovery: { generation: string; pools: number };
  prepareDaily: { date: string };
  saveApr: { poolId: string; status: "ok" | "degraded" | "error" };
  saveTokenIcons: { saved: number };
  /** `refreshedAt`: per pool, as `ActivePool.refreshedAt`. */
  ensureRhcRoster: { pools: number; profiles: Record<string, StoredProfile | null>; refreshedAt: Record<string, string | null> };
  rhcPools: SnapshotRhcPools;
};
/** Saved RHC pool summaries; `observedAt` is when the cron last read them, `stale` past the 26h rule. */
export type SnapshotRhcPools = { pools: Univ4PoolSummary[]; observedAt: string | null; stale: boolean };
export type StoreHandlers = {
  [K in StoreOperation]: (input: StoreRequest<K>) => Promise<StoreResultMap[K]>;
};
export interface RwaStore {
  request<K extends StoreOperation>(input: StoreRequest<K>): Promise<StoreResultMap[K]>;
}
