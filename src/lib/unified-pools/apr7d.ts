import { uiFor } from "@/lib/dex/ui";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { highestRangeSummary } from "@/lib/range-apr/preset-list";
import { rangeAprPayload } from "@/lib/range-apr/display-policy";
export { poolLpFeesPerDayUsd } from "@/lib/range-apr/estimate-policy";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";
import { aprSnapshotExpired, aprSnapshotLate } from "@/lib/rwa-freshness";
import { poolRankGroupOf, type RankGroupLookup, type UnifiedProtocol } from "./model";
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
    /** Average daily volume behind the estimate (for the volume divergence note). */
    avgDailyVolumeUsd: number | null;
    /** Complete UTC days the volume average was taken over (the sample window, zeros included). */
    days: number;
    freshness?: AprFreshness;
  }
  /**
   * No complete UTC day in the volume window: no APR is shown ("Too new"). `days` is the window length (0).
   */
  | { status: "new"; days: number; freshness?: AprFreshness }
  | { status: "missing"; reason: string; degraded?: boolean; freshness?: AprFreshness };

/**
 * Days of data behind the traded-day count: the payload's `dataDays` (`countDataDays`, days with both
 * volume and TVL), or the sample's calendar days on a snapshot saved before it existed.
 */
export function cardDataDays(payload: PoolRangeAprPayload): number {
  const strict = payload.sample.dataDays;
  return typeof strict === "number" && Number.isFinite(strict) ? strict : payload.sample.days;
}

/**
 * Complete UTC days the volume average was taken over (`sample.days`): the length of the window, including
 * zero-volume days. The card labels a window shorter than 7 days and hides an estimate only when this is 0.
 */
export function cardWindowDays(payload: PoolRangeAprPayload): number {
  return payload.sample.days;
}

/**
 * One pool's estimated highest range APR (up to a 7-day average) from its range-APR payload, with the same
 * `highestRangeSummary` the cards and the Create position modal use. Pure, so `/pools` (client) and the
 * homepage snapshot (server) resolve the identical number from the identical payload.
 *
 * The APR is the best fitting range's, at the common $1,000 preview basis, held only to every fee the pool's LPs took (a
 * deposit can never collect more than all of them), so a thin $126 pool cannot show a range APR its fees never paid. It is
 * not held to the pool's average fee rate: a concentrated range collects above that average by design, so that cap
 * replaced the range's number on most cards (15 of 20 live pools on 2026-11-10).
 *
 */
export function summarizeApr7d(payload: PoolRangeAprPayload, protocol: UnifiedProtocol, nowMs: number): Exclude<Apr7dState, { status: "loading" }> {
  const expired = aprSnapshotExpired(payload, nowMs);
  const priced = !expired ? rangeAprPayload(payload) : null;
  const summary = priced ? highestRangeSummary(OPEN_RANGE_UI_PRESETS, priced) : null;
  // Product rule: the number stays, labelled "Data delayed", while the snapshot is under 48h old; past 48h it is
  // "—" (`aprSnapshotExpired`). "Data delayed": server `stale` (older than 26h, or computed from saved price history,
  // see `aprSnapshotDelayed`), a failed last refresh, or a snapshot this browser already sees as late (cached response).
  const freshness = payload.freshness ? {
    snapshotAt: payload.freshness.snapshotAt,
    delayed: payload.freshness.stale || payload.freshness.lastAttemptStatus === "error" || expired || aprSnapshotLate(payload, nowMs),
  } : undefined;
  const days = cardWindowDays(payload);
  if (!expired && Number.isFinite(days) && hasTooFewDataDays(days)) {
    return { status: "new", days, freshness };
  }
  if (!summary) {
    return {
      status: "missing", freshness, degraded: payload.sample.degraded,
      reason: payload.sample.degraded ? "Not enough recent trading data for a 7-day estimate." : "No 7-day estimate right now.",
    };
  }
  const aprPct = summary.aprPct;
  return {
    status: "ready", freshness, aprPct, days,
    rangeLabel: uiFor(protocol).rangeApr?.rangeLabels?.[summary.id]
      ?? OPEN_RANGE_UI_PRESETS.find((preset) => preset.id === summary.id)?.label ?? summary.label,
    lowConfidence: payload.sample.confidence === "low",
    avgDailyVolumeUsd: Number.isFinite(payload.model?.avgDailyVolumeUsd) ? payload.model.avgDailyVolumeUsd : null,
  };
}

/** Rank groups for the list (`RankGroup`): Low TVL and Not supported yet. A short or missing APR no longer has its own group. */
export function rankGroupLookup(): RankGroupLookup {
  return poolRankGroupOf;
}
