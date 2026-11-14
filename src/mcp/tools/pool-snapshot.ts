import "@/lib/engine-host";
import { getRwaConfig } from "@/lib/config/rwa-env";
import { fetchPoolRangeApr } from "@/lib/pool-range-apr";
import { getRwaPairs, getRwaStore } from "@/lib/rwa-store";
import { RWA_PAIRS_LIST_QUERY } from "@/lib/rwa-pairs-list";
import type { RwaPairRow } from "@/lib/rwa-pairs";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";

/**
 * Read-only pool data for the public MCP tools (`list_rwa_pairs`, `get_pool_range_apr`).
 *
 * Production (RWA store enabled) reads only the saved snapshots the pools page reads: the same `getRwaPairs` query as
 * `/api/rwa-pairs` (Raydium + Meteora feeds) and the saved per-pool APR snapshot behind `/api/pool-range-apr`. No
 * Solana RPC, Raydium, Meteora or GeckoTerminal call is made here, and a pool outside the saved list is refused rather
 * than computed live. Results are held per instance for a short time, with in-flight de-duplication, so repeated
 * unauthenticated calls cannot multiply store reads.
 *
 * Without the store (a self-hosted stdio server) the existing live paths are used with the operator's own RPC.
 */

const PAIRS_TTL_MS = 60_000;
const APR_TTL_MS = 120_000;
const APR_CACHE_MAX_POOLS = 200;

type Entry<T> = { expiresAt: number; value?: T; pending?: Promise<T> };

/** Small TTL memo: one load per key at a time; failures are not cached. */
export function ttlMemo<T>(ttlMs: number, maxEntries: number, now: () => number = Date.now) {
  const entries = new Map<string, Entry<T>>();
  const memo = (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit?.pending) return hit.pending;
    if (hit && hit.value !== undefined && hit.expiresAt > now()) return Promise.resolve(hit.value);
    const pending = load().then(
      (value) => {
        entries.set(key, { expiresAt: now() + ttlMs, value });
        return value;
      },
      (error: unknown) => {
        entries.delete(key);
        throw error;
      },
    );
    entries.delete(key);
    entries.set(key, { expiresAt: 0, pending });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return pending;
  };
  memo.clear = () => entries.clear();
  return memo;
}

export type ListedPairs = {
  pairs: RwaPairRow[];
  fetchedAt: string;
  source: string;
  pairingRule: string;
  /** Saved snapshot (production) vs a live scan (self-hosted without the store). */
  snapshot: boolean;
  stale: boolean;
};

const pairsMemo = ttlMemo<ListedPairs>(PAIRS_TTL_MS, 1);
const aprMemo = ttlMemo<PoolRangeAprPayload>(APR_TTL_MS, APR_CACHE_MAX_POOLS);

/** Test hook: forget memoized reads. */
export function resetPoolSnapshotCache() {
  pairsMemo.clear();
  aprMemo.clear();
}

export function poolSnapshotEnabled(): boolean {
  return getRwaConfig().enabled;
}

/** The listed Solana pools exactly as the pools page lists them (same query, same listable filter). */
export function readListedPairs(): Promise<ListedPairs> {
  return pairsMemo("pairs", async () => {
    const result = await getRwaPairs({ ...RWA_PAIRS_LIST_QUERY });
    const body = result as typeof result & { freshness?: { stale?: boolean }; stale?: boolean };
    return {
      pairs: result.pairs,
      fetchedAt: result.fetchedAt,
      source: result.source,
      pairingRule: result.pairingRuleSummary,
      snapshot: poolSnapshotEnabled(),
      stale: body.freshness?.stale ?? body.stale ?? false,
    };
  });
}

/**
 * The saved 7-day range-APR snapshot for one pool. Production: the store only (no live fallback, so an untracked
 * pool fails instead of reaching RPC). Self-hosted without the store: the live estimate on the operator's RPC.
 */
export function readPoolApr(poolId: string): Promise<PoolRangeAprPayload> {
  return aprMemo(poolId, () => (poolSnapshotEnabled()
    ? getRwaStore().request({ op: "apr", poolId })
    : fetchPoolRangeApr(poolId)));
}
