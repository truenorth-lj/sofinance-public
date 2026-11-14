/**
 * Client entry point for DEX metadata and capabilities (DESIGN.md §1.4). Components import only from here (or
 * `@/lib/dex/types`); it carries no server code, SDK or protocol module.
 */
import { DEX_DESCRIPTORS } from "./descriptors";
import { createDexDescriptorRegistry } from "./registry";

export const dexDescriptors = createDexDescriptorRegistry(DEX_DESCRIPTORS);

export { uiFor, type UiForDeps } from "./ui";

export type * from "./types";
export { DEX_IDS, isDexId, normalizeDexId, feeRuleBps } from "./types";
export type { DexDescriptorRegistry } from "./registry";
export type { AddQuote, DepositMinimum, OpenQuote, OpenRangePreset, OpenRanges, PositionPerformance, RentQuote } from "./adapter";
export { DEPOSIT_MINIMUM_UNAVAILABLE, DEPOSIT_TOO_SMALL_PREFIX, depositTooSmallMessage, minimumDisplay } from "./deposit-minimum";
import type { AddQuote, OpenRanges } from "./adapter";
export { openSolNeed, openSolPartsFromQuote, openSolShortfall, SOL_NEED_UNKNOWN_COPY, type OpenSolParts, type OpenSolPartsResult, type OpenSolQuote } from "./sol-need";

/**
 * The preset ranges a pool can be opened with, worked out by the server from on-chain state (POST
 * /api/dex/[dex]/open-ranges). Independent of the volume / APR feed. Rejects with the server's plain reason.
 */
/** Shown when the server could not load a pool's ranges (5xx / no answer): plain words, never an error code. */
export const OPEN_RANGES_UNAVAILABLE = "We couldn't load this pool right now. Try again in a few minutes.";

export async function fetchOpenRanges(dexId: string, poolId: string, signal?: AbortSignal): Promise<OpenRanges> {
  const response = await fetch(`/api/dex/${encodeURIComponent(dexId)}/open-ranges`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poolId }), cache: "no-store", ...(signal ? { signal } : {}),
  });
  const body = await response.json().catch(() => null) as (OpenRanges & { error?: string }) | null;
  if (!response.ok || !body || !Array.isArray(body.presets)) {
    // A refusal (4xx) carries the server's plain reason; a server or upstream failure never shows its message or code.
    throw new Error(response.status >= 400 && response.status < 500 && body?.error ? body.error : OPEN_RANGES_UNAVAILABLE);
  }
  return body;
}
export { dexTxAdapter, DEX_PREPARE_TIMEOUT_MS, type DexPreparedStep, type DexStepInput, type DexStepOp } from "./tx-adapter";
export { dexPositionLabel, dexPositionRangeText, fetchDexPerformance, fetchDexPositions, positionDescriptorsFor } from "./positions-client";

/**
 * Pre-build check of an Add (POST /api/dex/[dex]/quote-add): today the "too small for this range" minimum. Resolves
 * `{}` when the DEX has no such check; rejects with the server's plain reason otherwise.
 */
export async function fetchAddQuote(dexId: string, body: { owner: string; positionKey: string; input: { token: string; amountRaw: string } },
  signal?: AbortSignal): Promise<AddQuote> {
  const response = await fetch(`/api/dex/${encodeURIComponent(dexId)}/quote-add`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", ...(signal ? { signal } : {}),
  });
  const parsed = await response.json().catch(() => null) as (AddQuote & { error?: string }) | null;
  if (!response.ok || !parsed) throw new Error(parsed?.error || `The add could not be checked (server error ${response.status}). Try again in a moment.`);
  return parsed;
}
