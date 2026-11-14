import "@/lib/engine-host";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { dexRegistry } from "@/lib/dex";
import { CARD_APR_DEPOSIT_USD } from "@/lib/lp-plan-pool-terms";
import { rangeAprPayload } from "@/lib/range-apr/display-policy";
import { highestRangeSummary } from "@/lib/range-apr/preset-list";
import type { RangeAprUnavailableReason } from "@/lib/range-apr/range-apr";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";
import { summarizeApr7d } from "@/lib/unified-pools/apr7d";
import type { UnifiedProtocol } from "@/lib/unified-pools/model";
import { buildOpenPositionUrl } from "../../lib/public-urls";
import type { GetPoolRangeAprInput } from "../schemas";
import { readListedPairs, readPoolApr } from "./pool-snapshot";

export const WINDOW_LABEL = "7-day estimate: the last 7 full UTC days of pool volume against the pool's current liquidity";
export const FEES_NOTE =
  "Estimates from past trading, not a promise of future fees. Fees accrue only while the pool price is inside your range.";

/** The four candidate ranges the pools page prices, narrow to wide (Micro is ±2 price steps of the pool). */
export const RANGE_PRESETS = OPEN_RANGE_UI_PRESETS.map(({ id, label, band }) => ({ id, label, band }));

export function protocolName(protocol: string): string {
  return dexRegistry.descriptorFor(protocol)?.displayName ?? protocol;
}

export const POOL_NOT_LISTED_MESSAGE =
  "This pool is not on the SoFinance pools list, so there is no saved 7-day estimate for it. Call list_rwa_pairs for the listed pools.";

export type PoolApr7dSummary =
  | {
    status: "ready";
    highestRangeAprPct: number;
    highestRange: string;
    lowConfidence: boolean;
    dataDelayed: boolean;
    snapshotAt?: string;
  }
  | { status: "new"; daysOfData: number; reason: string; snapshotAt?: string }
  | { status: "unavailable"; reason: string; snapshotAt?: string };

/** The same 7-day summary the pools page shows for a pool (`summarizeApr7d`), in agent-facing words. */
export function summarizePoolApr7d(payload: PoolRangeAprPayload, protocol: string, nowMs: number): PoolApr7dSummary {
  const state = summarizeApr7d(payload, protocol as UnifiedProtocol, nowMs);
  const snapshotAt = state.freshness?.snapshotAt;
  if (state.status === "ready") {
    return {
      status: "ready",
      highestRangeAprPct: state.aprPct,
      highestRange: state.rangeLabel,
      lowConfidence: state.lowConfidence,
      dataDelayed: state.freshness?.delayed ?? false,
      ...(snapshotAt ? { snapshotAt } : {}),
    };
  }
  if (state.status === "new") {
    return {
      status: "new", daysOfData: state.days,
      reason: "New pool: too few days of trading data for a 7-day estimate.",
      ...(snapshotAt ? { snapshotAt } : {}),
    };
  }
  return { status: "unavailable", reason: state.reason, ...(snapshotAt ? { snapshotAt } : {}) };
}

const UNAVAILABLE_WORDS: Record<RangeAprUnavailableReason, string> = {
  "invalid-range": "No estimate for this range.",
  "range-outside-window": "Not enough price history around this range.",
  "no-price": "No current price for this pool.",
  "no-capital": "No estimate for this range.",
  "degraded-data": "Not enough recent trading data.",
};

/**
 * 7-day fee APR for each of the four range presets of one listed pool, from its saved snapshot, priced at the same
 * $1,000 basis as the pool cards. Numbers appear only when the pools page would show one (not for new pools or
 * snapshots past the 48h limit).
 *
 * Safety: read-only. Production reads saved snapshots only (no RPC); no wallet or token needed.
 */
export async function getPoolRangeApr(input: GetPoolRangeAprInput) {
  const listed = await readListedPairs();
  const pair = listed.pairs.find((row) => row.poolAddress === input.poolId);
  if (!pair) throw new Error(POOL_NOT_LISTED_MESSAGE);
  const payload = await readPoolApr(pair.poolAddress);
  const summary = summarizePoolApr7d(payload, pair.protocol, Date.now());
  const ready = summary.status === "ready";
  const priced = ready ? rangeAprPayload(payload) : null;
  const best = priced ? highestRangeSummary(OPEN_RANGE_UI_PRESETS, priced) : null;
  const byId = new Map((priced ?? payload).presets.map((preset) => [preset.id, preset]));

  return {
    poolId: pair.poolAddress,
    chain: "solana",
    protocol: pair.protocol,
    protocolName: protocolName(pair.protocol),
    pair: `${pair.symbolA}/${pair.symbolB}`,
    symbolA: pair.symbolA,
    symbolB: pair.symbolB,
    feeTierBps: pair.feeTierBps,
    tvlUsd: pair.tvlUsd,
    window: {
      label: WINDOW_LABEL,
      days: payload.sample.days,
      startUtc: payload.sample.windowStartUtc ?? null,
      endUtc: payload.sample.windowEndUtc ?? null,
    },
    depositBasisUsd: CARD_APR_DEPOSIT_USD,
    priceUnit: `${pair.symbolB} per 1 ${pair.symbolA}`,
    status: summary.status,
    summary,
    highestRange: ready && best ? { id: best.id, label: summary.highestRange, aprPct: summary.highestRangeAprPct } : null,
    presets: RANGE_PRESETS.map((preset) => {
      const row = byId.get(preset.id);
      const base = {
        ...preset,
        priceLower: row?.priceLower ?? null,
        priceUpper: row?.priceUpper ?? null,
      };
      if (!ready || !row) return { ...base, status: "unavailable" as const };
      if (row.estimate.status !== "ok") {
        return { ...base, status: "unavailable" as const, reason: UNAVAILABLE_WORDS[row.estimate.reason] };
      }
      return {
        ...base,
        status: "ok" as const,
        aprPct: row.estimate.aprPct,
        inRangeVolumePct: row.estimate.inRangeVolumePct,
        feesPerDayUsd: row.estimate.feesPerDayUsd,
      };
    }),
    note: FEES_NOTE,
    openPositionUrl: buildOpenPositionUrl(pair.poolAddress),
  };
}
