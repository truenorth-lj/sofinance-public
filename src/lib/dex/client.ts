/**
 * Client entry point for DEX metadata and capabilities (DESIGN.md §1.4). Components import only from here (or
 * `@/lib/dex/types`); it carries no server code, SDK or protocol module.
 */
import { DEX_DESCRIPTORS } from "./descriptors";
import { createDexDescriptorRegistry } from "./registry";

export const dexDescriptors = createDexDescriptorRegistry(DEX_DESCRIPTORS);

export type * from "./types";
export { DEX_IDS, isDexId, normalizeDexId, feeRuleBps } from "./types";
export type { DexDescriptorRegistry } from "./registry";
export type { OpenQuote, OpenRangePreset, OpenRanges, PositionPerformance, RentQuote } from "./adapter";
import type { OpenRanges } from "./adapter";
export { openSolNeed, openSolPartsFromQuote, openSolShortfall, SOL_NEED_UNKNOWN_COPY, type OpenSolParts, type OpenSolPartsResult, type OpenSolQuote } from "./sol-need";

/**
 * The preset ranges a pool can be opened with, worked out by the server from on-chain state (POST
 * /api/dex/[dex]/open-ranges). Independent of the volume / APR feed. Rejects with the server's plain reason.
 */
export async function fetchOpenRanges(dexId: string, poolId: string, signal?: AbortSignal): Promise<OpenRanges> {
  const response = await fetch(`/api/dex/${encodeURIComponent(dexId)}/open-ranges`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poolId }), cache: "no-store", ...(signal ? { signal } : {}),
  });
  const body = await response.json().catch(() => null) as (OpenRanges & { error?: string }) | null;
  if (!response.ok || !body || !Array.isArray(body.presets)) {
    throw new Error(body?.error || `The server could not work out this pool's ranges (error ${response.status}). Try again in a moment.`);
  }
  return body;
}
export { dexTxAdapter, DEX_PREPARE_TIMEOUT_MS, type DexPreparedStep, type DexStepInput, type DexStepOp } from "./tx-adapter";
export { dexPositionLabel, dexPositionRangeText, dexRangeStatusText, fetchDexPerformance, fetchDexPositions, positionDescriptorsFor } from "./positions-client";
