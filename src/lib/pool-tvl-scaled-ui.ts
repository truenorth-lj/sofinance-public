/**
 * Pool TVL in the registry's unit for sources whose TVL leaves out the ScaledUiAmount multiplier (X3-7). The source is
 * named by its descriptor flag (`DexUi.tvlIncludesScaledUi: false`), never by a DEX id; the arithmetic is the engine's
 * `scaledUiTvlUsd`. Rows from other sources pass through unchanged. Pure; never adds a read.
 */
import { multiplierAt } from "@sofinance/engine/valuation/multiplier";
import { scaledUiTvlUsd } from "@sofinance/engine/valuation/pool-tvl";
import type { ScaledUiMultiplierConfig } from "@sofinance/engine/valuation/types";
import { uiFor } from "./dex/ui";
import { estimateFeeAprPct } from "./rwa-pairing";
import type { RwaPairRow } from "./rwa-pairs";

/** Whether this row's source publishes a TVL without the multiplier. */
export const tvlLeavesOutScaledUi = (protocol: string | undefined) =>
  protocol !== undefined && uiFor(protocol).tvlIncludesScaledUi === false;

/** A mint's multiplier from what is already known of it: unknown stays null, a mint without a config is 1. */
export function knownMultiplier(mint: { known: boolean; config: ScaledUiMultiplierConfig | undefined }, nowMs: number): number | null {
  if (!mint.known) return null;
  return multiplierAt(mint.config ? { kind: "scaled-ui", config: mint.config } : { kind: "none" }, nowMs);
}

/**
 * The row with `tvlUsd` (and the fee APR estimate that divides by it) in the registry's unit, plus `tvlScaledUi`
 * provenance. Idempotent: the source's figure is taken from earlier provenance when the row already has it.
 */
export function withScaledUiTvl(row: RwaPairRow, multipliers: { a: number | null; b: number | null }): RwaPairRow {
  if (!tvlLeavesOutScaledUi(row.protocol) || !row.tvlSides) return row;
  const sourceTvlUsd = row.tvlScaledUi?.sourceTvlUsd ?? row.tvlUsd;
  if (sourceTvlUsd === null) return row;
  const sides = row.tvlSides;
  const result = scaledUiTvlUsd({ sourceTvlUsd, sides: [
    { amount: sides.amountA, sharePriceUsd: sides.sharePriceUsdA, multiplier: multipliers.a },
    { amount: sides.amountB, sharePriceUsd: sides.sharePriceUsdB, multiplier: multipliers.b },
  ] });
  const mintsRead = multipliers.a !== null && multipliers.b !== null;
  return {
    ...row,
    tvlUsd: result.tvlUsd,
    estimatedFeeAprPct: row.fees24hUsd !== null ? estimateFeeAprPct(row.fees24hUsd, result.tvlUsd) : row.estimatedFeeAprPct,
    tvlScaledUi: result.kind === "corrected"
      ? { status: "corrected", sourceTvlUsd, mintsRead }
      : { status: "unverified", sourceTvlUsd, mintsRead, reason: result.reason },
  };
}
