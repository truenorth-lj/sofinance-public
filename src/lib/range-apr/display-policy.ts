import { CARD_APR_DEPOSIT_USD } from "@/lib/lp-plan-pool-terms";
import { capRangeEstimate } from "./estimate-policy";
import { payloadForCapital, sizeFitFor } from "./size-aware";
import type { PoolRangeAprPayload } from "./types";

/** Shared card/form preview basis; this never changes the user's amount or wallet. */
export function rangeAprPayload(
  payload: PoolRangeAprPayload,
  capitalUsd?: number | null,
  { enforceSizeFit = true }: { enforceSizeFit?: boolean } = {},
): PoolRangeAprPayload {
  if (payload.sample.degraded) return payload;
  const capital = typeof capitalUsd === "number" && Number.isFinite(capitalUsd) && capitalUsd > 0
    ? capitalUsd : CARD_APR_DEPOSIT_USD;
  // Keep server estimates when already priced at this capital.
  const priced = payload.referenceCapitalUsd === capital ? payload : payloadForCapital(payload, capital);
  return { ...priced, presets: priced.presets.map((preset, index) => {
    const candidate = {
      ...preset,
      // Changing capital cannot supply data that the server said was unavailable.
      estimate: capRangeEstimate(priced, payload.presets[index]?.estimate.status === "unavailable"
        ? payload.presets[index]!.estimate : preset.estimate),
    };
    // These guards model Raydium prepare, not other protocols' open flows. Remove
    // even pre-existing/repriced metadata so downstream ranking cannot apply it.
    if (enforceSizeFit) candidate.sizeFit = preset.sizeFit ?? sizeFitFor(priced, preset, capital);
    else delete candidate.sizeFit;
    return candidate;
  }) };
}
