/**
 * Server entry point for DEX capabilities (DESIGN.md §1.4). API routes, server use cases, cron and MCP import from
 * here, never from `src/lib/dex/<id>/**`, `@sofinance/engine/protocols/**` or a DEX SDK.
 */
import "server-only";
import { dexRegistry } from "./registry-instance";

export { dexRegistry };
export const prepareNativeAprRun: typeof dexRegistry.prepareNativeAprRun = (id, input) => dexRegistry.prepareNativeAprRun(id, input);
export type { NativeAprRun, NativeAprRunStats, NativeAprRunInput, PreparedAprPool, AprPoolOutcome } from "./apr-refresh";
export const readLpObservations: typeof dexRegistry.readLpObservations = (id, ...args) => dexRegistry.readLpObservations(id, ...args);
export const readLpExitPreview: typeof dexRegistry.readLpExitPreview = (id, ...args) => dexRegistry.readLpExitPreview(id, ...args);
export const protocolPoolReadPolicyFor: typeof dexRegistry.protocolPoolReadPolicyFor = (id) => dexRegistry.protocolPoolReadPolicyFor(id);
export const readProtocolPools: typeof dexRegistry.readProtocolPools = (id) => dexRegistry.readProtocolPools(id);
export const readProtocolRangeApr: typeof dexRegistry.readProtocolRangeApr = (id, poolId) => dexRegistry.readProtocolRangeApr(id, poolId);
export const evmPositionReadPolicyFor: typeof dexRegistry.evmPositionReadPolicyFor = (id) => dexRegistry.evmPositionReadPolicyFor(id);
export const readEvmPositions: typeof dexRegistry.readEvmPositions = (id, ...args) => dexRegistry.readEvmPositions(id, ...args);
export const readEvmPositionValues: typeof dexRegistry.readEvmPositionValues = (id, ids) => dexRegistry.readEvmPositionValues(id, ids);
export { PositionReadBusyError } from "./evm-position-read";
export const evmLiquiditySchemasFor: typeof dexRegistry.evmLiquiditySchemasFor = (id) => dexRegistry.evmLiquiditySchemasFor(id);
export const runEvmOpen: typeof dexRegistry.runEvmOpen = (id, command) => dexRegistry.runEvmOpen(id, command);
export const runEvmExit: typeof dexRegistry.runEvmExit = (id, command) => dexRegistry.runEvmExit(id, command);
export { EvmLiquidityInputError } from "./evm-liquidity";
export const readWithdrawalStatus: typeof dexRegistry.readWithdrawalStatus = (id, ...args) => dexRegistry.readWithdrawalStatus(id, ...args);
export type { WithdrawalStatusCommand, WithdrawalStatusResult } from "./withdraw-status";
export const discoverNativeWallet: typeof dexRegistry.discoverNativeWallet = (id, ...args) => dexRegistry.discoverNativeWallet(id, ...args);
// Keep optional listing/error dependencies out of unrelated registry consumers; capture identity before import.
export const listNativeWalletPositions: typeof import("./wallet-reads.server").listNativeWalletPositions =
  async ({ wallet }) => (await import("./wallet-reads.server")).listNativeWalletPositions({ wallet });
export type { DiscoverNativeWallet, NativeWalletListing, NativeListedPosition } from "./wallet-read";
export const readPositionPerformance: typeof dexRegistry.readPositionPerformance = (id, ...args) => dexRegistry.readPositionPerformance(id, ...args);
export { nativePositionSourceFor, nativePositionPerformance, nativePositionRangeStatus } from "./position-reads.server";
export type { NativePositionSource, NativePositionReader, PositionPerformanceCommand, PositionRangeCommand } from "./position-read";
export const readCompoundState: typeof dexRegistry.readCompoundState = (id, ...args) => dexRegistry.readCompoundState(id, ...args);
export const confirmCompound: typeof dexRegistry.confirmCompound = (id, ...args) => dexRegistry.confirmCompound(id, ...args);
export const importCompoundReceipt: typeof dexRegistry.importCompoundReceipt = (id, ...args) => dexRegistry.importCompoundReceipt(id, ...args);
export type { CompoundReadCommand, CompoundConfirmCommand, CompoundImportCommand, CompoundConfirmationResult } from "./compound-read";
export const validateSignedAdd: typeof dexRegistry.validateSignedAdd = (id, ...args) => dexRegistry.validateSignedAdd(id, ...args);
export { APP_SELECTED_SUBMIT, MCP_SELECTED_SUBMIT } from "./add-submit";
export type { AddValidationCommand, SelectedSubmitCommand, SelectedSubmitProfile } from "./add-submit";
export const quoteAdd: typeof dexRegistry.quoteAdd = (id, ...args) => dexRegistry.quoteAdd(id, ...args);
export const readAddState: typeof dexRegistry.readAddState = (id, ...args) => dexRegistry.readAddState(id, ...args);
export type { AddReadCommand, AddQuoteContext } from "./selected-read";
export { prepareOpen, quoteOpen } from "./prepare-open.server";
export { prepareSolSwapStep, readSolSwapStepStatus } from "./prepare-sol-swap.server";
export { APP_OPEN_PREPARE, MCP_OPEN_PREPARE, APP_OPEN_QUOTE, MCP_OPEN_QUOTE, SINGLE_TX_SOL_OPEN_MESSAGE } from "./open-prepare";
export { prepareCompound, simulateCompound, prepareCompoundRecovery } from "./prepare-compound.server";
export { APP_COMPOUND_PREPARE, MCP_COMPOUND_PREPARE } from "./compound-prepare";
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
