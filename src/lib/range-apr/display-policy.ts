import { CARD_APR_DEPOSIT_USD } from "@/lib/lp-plan-pool-terms";
import { capRangeEstimate } from "./estimate-policy";
import { payloadForCapital } from "./size-aware";
import type { PoolRangeAprPayload, RangeAprPresetEstimate } from "./types";

/** Shared card/form preview basis; this never changes the user's amount or wallet. */
export function rangeAprPayload(
  payload: PoolRangeAprPayload,
  capitalUsd?: number | null,
): PoolRangeAprPayload {
  if (payload.sample.degraded) return payload;
  const capital = typeof capitalUsd === "number" && Number.isFinite(capitalUsd) && capitalUsd > 0
    ? capitalUsd : CARD_APR_DEPOSIT_USD;
  // Keep server estimates when already priced at this capital.
  const priced = payload.referenceCapitalUsd === capital ? payload : payloadForCapital(payload, capital);
  return { ...priced, presets: priced.presets.map((preset, index) => {
    const { sizeFit: _ignored, ...rest } = preset as RangeAprPresetEstimate & { sizeFit?: unknown };
    return {
      ...rest,
      // Changing capital cannot supply data that the server said was unavailable.
      estimate: capRangeEstimate(priced, payload.presets[index]?.estimate.status === "unavailable"
        ? payload.presets[index]!.estimate : preset.estimate),
    };
  }) };
}
