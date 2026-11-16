/**
 * Server entry point for DEX capabilities (DESIGN.md §1.4). API routes, server use cases, cron and MCP import from
 * here, never from `src/lib/dex/<id>/**`, `@sofinance/engine/protocols/**` or a DEX SDK.
 */
import "server-only";
import { dexRegistry } from "./registry-instance";

export { dexRegistry };
export { prepareWithdrawal, quoteWithdrawal } from "./prepare-withdraw.server";
export { APP_WITHDRAW_PREPARE, MCP_WITHDRAW_PREPARE } from "./withdraw-prepare";
export type { WithdrawalPreparation } from "./withdraw-prepare";
export { prepareAdd } from "./prepare-add.server";
export const simulateAdd: typeof dexRegistry.buildAdd = (id, ...args) => dexRegistry.buildAdd(id, ...args);
export { APP_ADD_PREPARE, MCP_ADD_PREPARE } from "./add-prepare";
export type { AddPrepareCommand, AddPreparation, AddSubmitArgs } from "./add-prepare";

export type * from "./types";
export type * from "./adapter";
export { DEX_IDS, isDexId, normalizeDexId, feeRuleBps, NO_FEE } from "./types";
export { DexError, DexUnsupportedError, type DexErrorCode } from "./errors";
export { NO_FEE_POLICY, bpsFeeStrategy } from "./fees";
export { publicDexMessage } from "./public-message";
export type { DailyTvlStats, DexModule, DexRegistry } from "./registry";

/** Aggregate the discovered positions without loading protocol readers into unrelated DEX routes. */
export async function readPortfolio(input: import("@/lib/portfolio/model").PortfolioInput, signal: AbortSignal) {
  return (await import("./portfolio.server")).readPortfolio(input, signal);
}
