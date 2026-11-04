import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { highestRangeSummary } from "@/lib/range-apr/preset-list";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";
import { aprSnapshotExpired, aprSnapshotLate } from "@/lib/rwa-freshness";
import type { UnifiedPool, UnifiedProtocol } from "./model";
import { hasTooFewDataDays } from "@/lib/min-data-days";

/** When the pool's APR snapshot was taken, and whether its refresh is late or failed ("Data delayed"). */
export type AprFreshness = { snapshotAt: string; delayed: boolean };
export type Apr7dState =
  | { status: "loading" }
  | {
    status: "ready"; aprPct: number;
    /** The highest-APR candidate range, as the Create position modal names it ("Best"). */
    rangeLabel: string;
    /** Thin or patchy recent trading behind the estimate. */
    lowConfidence: boolean;
    /** 7-day average daily volume behind the estimate (for the volume divergence note). */
    avgDailyVolumeUsd: number | null;
    freshness?: AprFreshness;
  }
  /**
   * A pool younger than `MIN_DATA_DAYS` complete UTC days: no APR is shown ("New pool · N days of data") and it is left
   * out of the APR ranking. `days`: complete days the estimate would have averaged over.
   */
  | { status: "new"; days: number; freshness?: AprFreshness }
  | { status: "missing"; reason: string; degraded?: boolean; freshness?: AprFreshness };

/**
 * One pool's estimated highest range APR (7-day average) from its range-APR payload, with the same
 * `highestRangeSummary` the cards and the Create position modal use. Pure, so `/app/rwa-pairs` (client) and the
 * homepage snapshot (server) resolve the identical number from the identical payload.
 */
export function summarizeApr7d(payload: PoolRangeAprPayload, protocol: UnifiedProtocol, nowMs: number): Exclude<Apr7dState, { status: "loading" }> {
  const expired = aprSnapshotExpired(payload, nowMs);
  const summary = !expired ? highestRangeSummary(OPEN_RANGE_UI_PRESETS, payload) : null;
  // Product rule: the number stays, labelled "Data delayed", while the snapshot is under 48h old; past 48h it is
  // "—" (`aprSnapshotExpired`). "Data delayed": server `stale` (older than 26h, or computed from saved price history,
  // see `aprSnapshotDelayed`), a failed last refresh, or a snapshot this browser already sees as late (cached response).
  const freshness = payload.freshness ? {
    snapshotAt: payload.freshness.snapshotAt,
    delayed: payload.freshness.stale || payload.freshness.lastAttemptStatus === "error" || expired || aprSnapshotLate(payload, nowMs),
  } : undefined;
  if (!expired && Number.isFinite(payload.sample.days) && hasTooFewDataDays(payload.sample.days)) {
    return { status: "new", days: payload.sample.days, freshness };
  }
  if (!summary) {
    return {
      status: "missing", freshness, degraded: payload.sample.degraded,
      reason: payload.sample.degraded ? "Not enough recent trading data for a 7-day estimate." : "No 7-day estimate right now.",
    };
  }
  return {
    status: "ready", aprPct: summary.aprPct, freshness,
    rangeLabel: protocol === "uniswap-v4-rhc" && summary.id === "micro"
      ? "Min (±10 ticks)"
      : OPEN_RANGE_UI_PRESETS.find((preset) => preset.id === summary.id)?.label ?? summary.label,
    lowConfidence: payload.sample.confidence === "low",
    avgDailyVolumeUsd: Number.isFinite(payload.model?.avgDailyVolumeUsd) ? payload.model.avgDailyVolumeUsd : null,
  };
}

/**
 * The pools with a new pool's 24h APR blanked (`status: "new"`), so no APR figure shows on its card or row and it sorts
 * last by either APR column. The 7-day column already has no number for it (`status === "ready"` only).
 */
export function withoutNewPoolAprs<T extends UnifiedPool>(pools: readonly T[], apr: Readonly<Record<string, Apr7dState | undefined>>): T[] {
  return pools.map((pool) => (apr[pool.key]?.status === "new" && pool.poolFeeApr24hPct !== null ? { ...pool, poolFeeApr24hPct: null } : pool));
}
