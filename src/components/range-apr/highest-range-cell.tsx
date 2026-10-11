"use client";

import { APR_ESTIMATE_CAVEAT, HIGHEST_RANGE_HELP } from "@/lib/range-apr/copy";
import { formatAprPct, unavailableReasonText } from "@/lib/range-apr/format";
import { highestRangeSummary } from "@/lib/range-apr/preset-list";
import { OPEN_RANGE_UI_PRESETS } from "@/lib/open-range-presets";
import { InfoTip } from "../info-tip";
import { usePoolRangeApr } from "./use-pool-range-apr";

/**
 * "Highest range" cell of the pairs table: the candidate range with the highest estimated fee APR and that
 * APR, e.g. "Tight · ~38% APR". Plain text. Reads the same cached payload and the same pure resolver the
 * Create position modal uses for its "Best" button, so the two always agree.
 */
export function HighestRangeCell({ poolId }: { poolId: string }) {
  const apr = usePoolRangeApr(poolId);
  const summary = apr.status === "ready" ? highestRangeSummary(OPEN_RANGE_UI_PRESETS, apr.data) : null;
  const degraded = apr.status === "ready" && apr.data.sample.degraded;
  const low = apr.status === "ready" && apr.data.sample.confidence === "low";
  const text = apr.status === "loading"
    ? "…"
    : summary ? `${summary.label} · ${formatAprPct(summary.aprPct)} APR${low ? "*" : ""}` : "—";
  return (
    <div className="flex items-center gap-1 whitespace-nowrap">
      <span className="font-semibold tabular-nums text-cream/90" data-testid="highest-range">{text}</span>
      {degraded && (
        <InfoTip label="About Highest range" placement="above">{unavailableReasonText("degraded-data")}.</InfoTip>
      )}
      {summary && (
        <InfoTip label="About Highest range" placement="above">
          {APR_ESTIMATE_CAVEAT} {HIGHEST_RANGE_HELP}{low ? " * Low confidence: thin or patchy recent trading." : ""}
        </InfoTip>
      )}
    </div>
  );
}
