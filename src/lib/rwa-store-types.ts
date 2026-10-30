import { z } from "zod";
import type {
  DiscoverRwaPairsResult,
  RwaPairRow,
  RwaPairSortBy,
} from "./rwa-pairs";
import type { PoolRangeAprPayload } from "./range-apr/types";
import type { VolumeProfile } from "./pool-range-apr";
import { trustedIcon } from "@sofinance/engine/token-metadata";
import { iconAddress, validIconAddress, type TokenIconMap, type TokenIconRow } from "./token-icons/map";

export const FEED_KEY = "raydium-clmm-rwa-v1";
export const FEED_KEY_RHC = "uniswap-v4-rhc-v1";
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
};
export type ActivePool = {
  pair: RwaPairRow;
  metricsObservedAt: string;
  profile: StoredProfile | null;
};
export type AprWrite = {
  poolId: string;
  payload: PoolRangeAprPayload | null;
  profile: StoredProfile | null;
  chainObservedAt: string | null;
  issues: string[];
};
export type DiscoveryWrite = {
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
});
const aprSchema = z.object({
  poolId: poolSchema,
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
        .length(4),
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
    })
    .nullable(),
  chainObservedAt: timestamp.nullable(),
  issues: z.array(z.string().max(500)).max(20),
});

/** Icon rows from the daily refresh. Re-checked against `ICON_HOSTS` here so no caller can store an off-list link. */
export const tokenIconWriteSchema = z.array(z.object({
  chain: z.enum(["solana", "robinhood"]),
  address: z.string().max(64),
  image: z.string().max(1024),
  source: z.enum(["jupiter", "raydium", "dexscreener", "geckoterminal", "manual"]),
}).refine((row) => validIconAddress(row.chain, row.address) && row.address === iconAddress(row.chain, row.address)
  && trustedIcon(row.image) === row.image, "Untrusted token icon")).max(500);
export type TokenIconWrite = TokenIconRow[];

export const storeRequestSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("pairs"),
    minTvl: z.number().finite().min(0).max(1e12),
    maxPages: z.number().int().min(1).max(30),
    sortBy: z.enum(["estimatedFeeApr", "tvl", "volume24h"]),
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
  z.object({ op: z.literal("activePools") }),
  z.object({
    op: z.literal("saveApr"),
    lease: leaseSchema,
    data: z.custom<AprWrite>((value) => aprSchema.safeParse(value).success),
  }),
  z.object({ op: z.literal("prepareDaily"), lease: leaseSchema }),
  z.object({ op: z.literal("ensureRhcRoster"), lease: leaseSchema }),
  z.object({ op: z.literal("saveTokenIcons"), lease: leaseSchema, data: tokenIconWriteSchema }),
]);
export type StoreRequest = z.infer<typeof storeRequestSchema>;
export type PairOptions = {
  minTvl: number;
  maxPages: number;
  sortBy: RwaPairSortBy;
};
/** `tokenIcons` is absent from stores that predate it; readers fall back (see `iconFor`). */
export type SnapshotPairs = DiscoverRwaPairsResult & { freshness: Freshness; tokenIcons?: TokenIconMap };
export type SnapshotApr = PoolRangeAprPayload & { freshness: Freshness };

export interface RwaStore {
  request(input: StoreRequest): Promise<unknown>;
}
