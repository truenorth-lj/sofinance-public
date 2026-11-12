/**
 * Server entry point for DEX capabilities (DESIGN.md §1.4). API routes, server use cases, cron and MCP import from
 * here, never from `src/lib/dex/<id>/**`, `@sofinance/engine/protocols/**` or a DEX SDK.
 */
import "server-only";
import { DEX_MODULES } from "./modules";
import { createDexRegistry } from "./registry";

export const dexRegistry = createDexRegistry(DEX_MODULES);

export type * from "./types";
export type * from "./adapter";
export { DEX_IDS, isDexId, normalizeDexId, feeRuleBps, NO_FEE } from "./types";
export { DexError, DexUnsupportedError, type DexErrorCode } from "./errors";
export { NO_FEE_POLICY, bpsFeeStrategy } from "./fees";
export { publicDexMessage } from "./public-message";
export type { DailyTvlStats, DexModule, DexRegistry } from "./registry";
