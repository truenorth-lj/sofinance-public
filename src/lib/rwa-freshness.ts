import type { PoolRangeAprPayload } from "./range-apr/types";
import { volumeWindowEnd } from "./rwa-daily";

/**
 * How often production refreshes saved APR snapshots: the Vercel cron in `vercel.json` runs
 * `/api/internal/rwa-refresh` once a day at 00:15 UTC (08:15 Taipei, inside the 08:10–09:10 Taipei daily-sample
 * window and after the last complete UTC volume day closes). `vercel.json` must keep this schedule (tested).
 */
export const RWA_REFRESH_CRON = "15 0 * * *";

/**
 * A displayed estimate expires when its chain observation is older than this: one daily refresh plus a 2-hour
 * grace for a slow or retried run. The 7-day volume window only moves once a day, so a snapshot from today's run
 * is the current estimate all day. (It was 30 minutes while the cron ran every 15 minutes; with the daily cron
 * from #234 that hid every pool's 7d APR as "—" about 30 minutes after each run.)
 */
export const APR_SNAPSHOT_MAX_AGE_MS = 26 * 3_600_000;

/**
 * `/api/rwa-pairs` (Postgres store) marks the published pool list stale after this. Same as the client APR expiry:
 * the list is published by the same daily refresh, so it is current all day. (It was 30 minutes, which flagged it
 * stale for ~23.5 hours a day under the daily cron.) Write-side guards inside one refresh run keep their own
 * 30-minute windows.
 */
export const RWA_PAIRS_STALE_MS = APR_SNAPSHOT_MAX_AGE_MS;

export function aprSnapshotExpired(
  payload: PoolRangeAprPayload,
  nowMs: number,
) {
  if (!payload.freshness) return false;
  const stamp = Date.parse(
    payload.freshness.chainObservedAt ?? payload.freshness.snapshotAt,
  );
  return !Number.isFinite(stamp) || nowMs - stamp > APR_SNAPSHOT_MAX_AGE_MS;
}

/**
 * Whether a saved pool APR snapshot should say "Data delayed" (`freshness.stale` from `/api/pool-range-apr`).
 * The daily refresh writes every pool once a day, so a snapshot is current until it is older than
 * `APR_SNAPSHOT_MAX_AGE_MS` (26h). It was 10 minutes (chain) / 30 minutes (volume) plus "volume window is not
 * today's", tuned for the old 15-minute cron, which flagged every pool "Data delayed" for almost the whole day.
 * Still delayed: a chain or volume observation older than 26h (the refresh missed a run), an unreadable timestamp,
 * or a 7-day volume window that ends earlier than any run within the last 26h could have produced.
 */
export function aprSnapshotDelayed(
  snapshot: { chainObservedAt: string; volumeObservedAt: string; windowEndUtc?: string | null },
  nowMs: number,
) {
  const chain = Date.parse(snapshot.chainObservedAt);
  const volume = Date.parse(snapshot.volumeObservedAt);
  const windowEnd = snapshot.windowEndUtc ? Date.parse(snapshot.windowEndUtc) : Number.NaN;
  if (![chain, volume, windowEnd].every(Number.isFinite)) return true;
  if (nowMs - chain > APR_SNAPSHOT_MAX_AGE_MS || nowMs - volume > APR_SNAPSHOT_MAX_AGE_MS) return true;
  return windowEnd < Date.parse(volumeWindowEnd(nowMs - APR_SNAPSHOT_MAX_AGE_MS));
}
