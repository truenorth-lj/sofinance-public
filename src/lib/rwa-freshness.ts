import type { PoolRangeAprPayload } from "./range-apr/types";
import { volumeWindowEnd } from "./rwa-daily";

/**
 * How often production refreshes saved APR snapshots: the Vercel cron in `vercel.json` runs
 * `/api/internal/rwa-refresh` every 4 hours at minute 15 (00:15, 04:15, … UTC = 08:15, 12:15, … Taipei; the 00:15 UTC
 * run comes right after the last complete UTC volume day closes). Each run refreshes the `APR_POOLS_PER_RUN`
 * pools whose 7d APR is oldest (see `rwa-refresh.ts`). `vercel.json` must keep this schedule (tested).
 */
export const RWA_REFRESH_CRON = "15 */4 * * *";

/**
 * A saved snapshot is current for one daily refresh plus a 2-hour grace for a slow or retried run; after this it
 * says "Data delayed". Used by the 24h column / pool list (`RWA_PAIRS_STALE_MS`) and the 7d APR "Data delayed"
 * label (`aprSnapshotDelayed`). (It was 30 minutes while the cron ran every 15 minutes.)
 */
export const APR_SNAPSHOT_MAX_AGE_MS = 26 * 3_600_000;
/** Clearer name for the same 26h "Data delayed" threshold. */
export const APR_SNAPSHOT_DELAYED_AFTER_MS = APR_SNAPSHOT_MAX_AGE_MS;

/**
 * Product rule (7d APR): a snapshot keeps showing its number, labelled "Data delayed", while it is under 48h old;
 * only after that is the 7d APR shown as "—". A failed daily run therefore never blanks the column by itself.
 */
export const APR_7D_SNAPSHOT_MAX_AGE_MS = 48 * 3_600_000;

/**
 * The refresh may compute an estimate from earlier saved price history (when today's candle fetch failed, e.g.
 * GeckoTerminal 429) while that history is at most this old. Same 48h as the 7d display limit, so an estimate
 * built from saved history never outlives the data it came from (see `aprSnapshotExpired`).
 */
export const SAVED_PRICE_HISTORY_MAX_AGE_MS = APR_7D_SNAPSHOT_MAX_AGE_MS;

/**
 * `/api/rwa-pairs` (Postgres store) marks the published pool list (and so the 24h column) stale after this. The
 * list is published by the same daily refresh, so it is current all day. Unchanged by the 48h 7d rule.
 * Write-side guards inside one refresh run keep their own 30-minute windows.
 */
export const RWA_PAIRS_STALE_MS = APR_SNAPSHOT_DELAYED_AFTER_MS;

/**
 * Age of the data behind a saved 7d estimate: its chain observation, or (when it was computed from saved price
 * history) the older of that and the price history's own observation. NaN when unreadable; null when unsaved.
 */
export function aprSnapshotAgeMs(payload: PoolRangeAprPayload, nowMs: number): number | null {
  const freshness = payload.freshness;
  if (!freshness) return null;
  const chain = Date.parse(freshness.chainObservedAt ?? freshness.snapshotAt);
  const volume = payload.sample.priceHistoryStale && freshness.volumeObservedAt ? Date.parse(freshness.volumeObservedAt) : chain;
  return nowMs - Math.min(chain, volume);
}

/** The 7d APR shows "—" (no number) once the snapshot's data is older than 48h, or its time is unreadable. */
export function aprSnapshotExpired(payload: PoolRangeAprPayload, nowMs: number) {
  const age = aprSnapshotAgeMs(payload, nowMs);
  return age !== null && (!Number.isFinite(age) || age > APR_7D_SNAPSHOT_MAX_AGE_MS);
}

/** Browser-side "Data delayed" for a saved 7d snapshot (also when a cached response has aged past 26h here). */
export function aprSnapshotLate(payload: PoolRangeAprPayload, nowMs: number) {
  const age = aprSnapshotAgeMs(payload, nowMs);
  if (age === null) return false;
  return !Number.isFinite(age) || age > APR_SNAPSHOT_DELAYED_AFTER_MS || !!payload.sample.priceHistoryStale;
}

/**
 * Whether a saved pool APR snapshot should say "Data delayed" (`freshness.stale` from `/api/pool-range-apr`).
 * The 4-hourly refresh (oldest first) writes every pool at least once a day, so a snapshot is current until it is older than
 * `APR_SNAPSHOT_MAX_AGE_MS` (26h). It was 10 minutes (chain) / 30 minutes (volume) plus "volume window is not
 * today's", tuned for the old 15-minute cron, which flagged every pool "Data delayed" for almost the whole day.
 * Still delayed: a chain or volume observation older than 26h (the refresh missed a run), an unreadable timestamp,
 * a 7-day volume window that ends earlier than any run within the last 26h could have produced, or an estimate
 * computed from saved price history (`sample.priceHistoryStale`).
 */
export function aprSnapshotDelayed(
  snapshot: { chainObservedAt: string; volumeObservedAt: string; windowEndUtc?: string | null; priceHistoryStale?: boolean },
  nowMs: number,
) {
  // Computed from earlier saved price history (today's fetch failed): the number stands, but it is delayed.
  if (snapshot.priceHistoryStale) return true;
  const chain = Date.parse(snapshot.chainObservedAt);
  const volume = Date.parse(snapshot.volumeObservedAt);
  const windowEnd = snapshot.windowEndUtc ? Date.parse(snapshot.windowEndUtc) : Number.NaN;
  if (![chain, volume, windowEnd].every(Number.isFinite)) return true;
  if (nowMs - chain > APR_SNAPSHOT_MAX_AGE_MS || nowMs - volume > APR_SNAPSHOT_MAX_AGE_MS) return true;
  return windowEnd < Date.parse(volumeWindowEnd(nowMs - APR_SNAPSHOT_MAX_AGE_MS));
}
