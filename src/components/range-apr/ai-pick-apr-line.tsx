"use client";

import { AI_PICK_APR_LABEL, APR_ESTIMATE_CAVEAT } from "@/lib/range-apr/copy";
import { AI_PICK_HELP } from "@/lib/range-apr/ai-pick";
import { formatEstimate } from "@/lib/range-apr/format";
import { InfoTip } from "../info-tip";
import { usePoolRangeApr } from "./use-pool-range-apr";

/**
 * Plain-text "AI-pick est. APR" for one pool (no chart), read from the same cached payload and the same
 * preset estimate the Create position modal shows for its AI pick button.
 */
export function AiPickAprLine({ poolId }: { poolId: string }) {
  const apr = usePoolRangeApr(poolId);
  const estimate = apr.status === "ready" ? apr.data.presets.find((preset) => preset.id === "ai")?.estimate : undefined;
  const value = apr.status === "loading" ? "…" : formatEstimate(estimate);
  const low = apr.status === "ready" && apr.data.sample.confidence === "low";
  return (
    <div className="mt-1 flex items-center gap-1 whitespace-nowrap text-[11px] font-normal text-smoke">
      <span>{AI_PICK_APR_LABEL}</span>
      <span className="font-semibold tabular-nums text-cream/90" data-testid="ai-pick-apr">{value}{low && value !== "—" ? "*" : ""}</span>
      <InfoTip label={`About ${AI_PICK_APR_LABEL}`} placement="above">
        {APR_ESTIMATE_CAVEAT} {AI_PICK_HELP}{low ? " * Low confidence: thin or patchy recent trading." : ""}
      </InfoTip>
    </div>
  );
}
