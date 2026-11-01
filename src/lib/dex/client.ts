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
export { dexTxAdapter, DEX_PREPARE_TIMEOUT_MS, type DexPreparedStep, type DexStepInput, type DexStepOp } from "./tx-adapter";
export { dexPositionLabel, dexPositionRangeText, dexRangeStatusText, fetchDexPositions, positionDescriptorsFor } from "./positions-client";
