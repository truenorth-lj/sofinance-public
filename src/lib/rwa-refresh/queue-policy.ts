import type { ActivePool } from "../rwa-store-types";

/** No pool is started inside this last part of the APR job: `prepareDaily`, `finish` and the response. */
export const APR_SAVE_RESERVE_MS = 10_000;

/**
 * Queue key of a Solana pool: the store's `refreshedAt`, else (an older store / gateway that does not send it)
 * the saved profile's last fetch attempt or observation, so the queue never falls back to pool id order alone.
 */
export function activePoolRefreshedAt(pool: Pick<ActivePool, "refreshedAt" | "profile">): string | null {
  return pool.refreshedAt ?? pool.profile?.fetchState?.lastAttemptAt ?? pool.profile?.observedAt ?? null;
}

/**
 * The APR queue order: pools never refreshed first, then the oldest last refresh or attempt (`refreshedAt`), then
 * pool id (stable). Solana and RHC pools in one list.
 * `refreshedAt` is `GREATEST(payload_snapshot_at, last_attempt_at)` from the store (`refreshedAtSql`), so in practice
 * it is the pool's last attempt: every save (ok, degraded or error) sets `last_attempt_at`, and a snapshot is never
 * newer than the attempt that wrote it. A pool cut by a 429 or the time budget saves nothing, keeps its old key and
 * goes first next run; a failing pool still rotates to the back instead of blocking the queue.
 */
export function orderAprQueue<T extends { poolId: string; refreshedAt?: string | null }>(items: readonly T[]): T[] {
  const at = (item: T) => {
    const ms = item.refreshedAt ? Date.parse(item.refreshedAt) : Number.NaN;
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  return [...items].sort((a, b) => at(a) - at(b) || (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0));
}

