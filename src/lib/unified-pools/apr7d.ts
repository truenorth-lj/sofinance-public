import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { highestRangeSummary } from "@/lib/range-apr/preset-list";
import { payloadForCapital } from "@/lib/range-apr/size-aware";
import { capAprAtPoolFees, CARD_APR_DEPOSIT_USD } from "@/lib/lp-plan-pool-terms";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";
import { aprSnapshotExpired, aprSnapshotLate } from "@/lib/rwa-freshness";
import { poolRankGroup, type RankGroupLookup, type UnifiedPool, type UnifiedProtocol } from "./model";
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

function withoutSizeFit<T extends { sizeFit?: unknown }>(preset: T): T {
  const copy = { ...preset };
  delete copy.sizeFit;
  return copy;
}

/**
 * The payload re-priced for a `depositUsd` deposit (`payloadForCapital`, the Create position modal's re-pricing) minus
 * its size-fit exclusions, so the card still names the best range of a small pool.
 */
function pricedFor(payload: PoolRangeAprPayload, depositUsd: number): PoolRangeAprPayload {
  if (payload.referenceCapitalUsd === depositUsd) return payload; // already priced for that deposit
  const priced = payloadForCapital(payload, depositUsd);
  return priced === payload ? payload : { ...priced, presets: priced.presets.map(withoutSizeFit) };
}

/** USD fees the pool's LPs took per day on average over the sample window (volume × fee × LP share), or null. */
export function poolLpFeesPerDayUsd(payload: PoolRangeAprPayload): number | null {
  const volume = payload.model?.avgDailyVolumeUsd, fee = payload.pool.feeRate, share = payload.pool.lpFeeFraction;
  return [volume, fee, share].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    ? volume * fee * share : null;
}

/**
 * Days of data behind the card: the payload's `dataDays` (`countDataDays`, the calculator's count: days with both
 * volume and TVL), or the sample's calendar days on a snapshot saved before it existed.
 */
export function cardDataDays(payload: PoolRangeAprPayload): number {
  const strict = payload.sample.dataDays;
  return typeof strict === "number" && Number.isFinite(strict) ? strict : payload.sample.days;
}

/**
 * One pool's estimated highest range APR (7-day average) from its range-APR payload, with the same
 * `highestRangeSummary` the cards and the Create position modal use. Pure, so `/app/rwa-pairs` (client) and the
 * homepage snapshot (server) resolve the identical number from the identical payload.
 *
 * The APR is the best range's, for a `CARD_APR_DEPOSIT_USD` deposit, held only to every fee the pool's LPs took (a
 * deposit can never earn more than all of them), so a thin $126 pool cannot show a range APR its fees never paid. It is
 * not held to the pool's average fee rate: a concentrated range earns above that average by design, so that cap
 * replaced the range's number on most cards (15 of 20 live pools on 2026-11-10).
 */
export function summarizeApr7d(payload: PoolRangeAprPayload, protocol: UnifiedProtocol, nowMs: number): Exclude<Apr7dState, { status: "loading" }> {
  const expired = aprSnapshotExpired(payload, nowMs);
  const summary = !expired ? highestRangeSummary(OPEN_RANGE_UI_PRESETS, pricedFor(payload, CARD_APR_DEPOSIT_USD)) : null;
  // Product rule: the number stays, labelled "Data delayed", while the snapshot is under 48h old; past 48h it is
  // "—" (`aprSnapshotExpired`). "Data delayed": server `stale` (older than 26h, or computed from saved price history,
  // see `aprSnapshotDelayed`), a failed last refresh, or a snapshot this browser already sees as late (cached response).
  const freshness = payload.freshness ? {
    snapshotAt: payload.freshness.snapshotAt,
    delayed: payload.freshness.stale || payload.freshness.lastAttemptStatus === "error" || expired || aprSnapshotLate(payload, nowMs),
  } : undefined;
  const days = cardDataDays(payload);
  if (!expired && Number.isFinite(days) && hasTooFewDataDays(days)) {
    return { status: "new", days, freshness };
  }
  if (!summary) {
    return {
      status: "missing", freshness, degraded: payload.sample.degraded,
      reason: payload.sample.degraded ? "Not enough recent trading data for a 7-day estimate." : "No 7-day estimate right now.",
    };
  }
  // TVL 0: the cap is the pool's whole LP fee income (the deposit takes all of it), not a share of it.
  const aprPct = capAprAtPoolFees(summary.aprPct, { poolLpFeesPerDayUsd: poolLpFeesPerDayUsd(payload), poolTvlUsd: 0, depositUsd: CARD_APR_DEPOSIT_USD });
  return {
    status: "ready", freshness, aprPct,
    rangeLabel: protocol === "uniswap-v4-rhc" && summary.id === "micro"
      ? "Min (±10 ticks)"
      : OPEN_RANGE_UI_PRESETS.find((preset) => preset.id === summary.id)?.label ?? summary.label,
    lowConfidence: payload.sample.confidence === "low",
    avgDailyVolumeUsd: Number.isFinite(payload.model?.avgDailyVolumeUsd) ? payload.model.avgDailyVolumeUsd : null,
  };
}

/** Rank groups for the list (`RankGroup`): a pool whose APR state is "new" ranks with the new pools. */
export function rankGroupLookup(apr: Readonly<Record<string, Apr7dState | undefined>>): RankGroupLookup {
  return (pool: UnifiedPool) => poolRankGroup(pool, apr[pool.key]?.status === "new");
}
