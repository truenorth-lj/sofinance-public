import "server-only";
import { getRwaConfig } from "./config/rwa-env";
import { discoverRwaPairs, getCachedRwaPairs } from "./rwa-pairs";
import { listablePairs } from "./rwa-listable";
import { listedSolanaFeedKeys } from "./rwa-listed-feeds";
import { fetchPoolRangeApr } from "./pool-range-apr";
import { NotRaydiumClmmPoolError, POOL_NOT_TRACKED_MESSAGE } from "./range-apr/not-clmm-pool";
import { PostgresRwaStore } from "./rwa-postgres-store";
import { tokenIconMap } from "./token-icons/map";
import {
  FEED_KEY,
  RwaStoreError,
  type PairOptions,
  type SolanaFeedKey,
  type RwaStore,
} from "./rwa-store-types";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";
import { createRoutedStore } from "./routed-store";

export const getRwaStore = createRoutedStore<RwaStore>({
  path: "/v1/rwa",
  ErrorClass: RwaStoreError,
  unavailableCode: "RWA_STORE_UNAVAILABLE",
  makePostgres: (db) => new PostgresRwaStore(db),
  timeoutMs: 10_000,
  refreshDirectIfPoolRetired: true,
});

/** Listed pairs (list page and home top-5): scan-blocked pools (paused / transfer fee / frozen mint) are dropped. */
export async function getRwaPairs(input: PairOptions & {
  /** Default: the listed feeds (`listedSolanaFeedKeys`). */
  feedKeys?: readonly SolanaFeedKey[];
}) {
  const { feedKeys = listedSolanaFeedKeys(), ...options } = input;
  if (!getRwaConfig().enabled) {
    const live = await (getCachedRwaPairs(options.minTvl, options.maxPages, options.sortBy) ?? discoverRwaPairs(options));
    return { ...live, pairs: listablePairs(live.pairs) };
  }
  const snapshot = await getRwaStore().request({
    op: "pairs",
    ...options,
    // Only a second feed is sent: a Raydium-only read is the same request as before.
    ...(feedKeys.length > 1 || feedKeys[0] !== FEED_KEY ? { feedKeys: [...feedKeys] } : {}),
  });
  // A gateway running an older store build returns no `tokenIcons`; keep the manual list in that case.
  return { ...snapshot, pairs: listablePairs(snapshot.pairs), tokenIcons: snapshot.tokenIcons ?? tokenIconMap([]) };
}
export async function getPoolAprSnapshot(poolId: string) {
  if (!getRwaConfig().enabled) return fetchPoolRangeApr(poolId);
  try {
    return await getRwaStore().request({ op: "apr", poolId });
  } catch (error) {
    // This endpoint also serves ordinary CLMM positions. Only pools never in
    // the RWA feed keep that existing path; failed tracked snapshots fail closed.
    if (error instanceof RwaStoreError && error.code === "POOL_NOT_TRACKED") {
      try {
        return await fetchPoolRangeApr(poolId);
      } catch (fallbackError) {
        // Not in the RWA feed and not a Raydium CLMM pool (e.g. a pool from another protocol): nothing to serve.
        if (fallbackError instanceof NotRaydiumClmmPoolError) throw new RwaStoreError("POOL_NOT_TRACKED");
        throw fallbackError;
      }
    }
    throw error;
  }
}

export function snapshotError(error: unknown) {
  const code =
    error instanceof RwaStoreError ? error.code : "RWA_STORE_UNAVAILABLE";
  if (code === "POOL_NOT_TRACKED")
    return Response.json({ error: POOL_NOT_TRACKED_MESSAGE, code }, { status: 404, headers: NO_STORE_HEADERS });
  return Response.json(
    {
      error:
        "Saved pool data is temporarily unavailable. Please try again shortly.",
      code,
    },
    {
      status: 503,
      headers: { ...NO_STORE_HEADERS, "Retry-After": "60" },
    },
  );
}
