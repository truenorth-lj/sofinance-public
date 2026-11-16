import type { DexModule } from "../registry";
import { raydiumClmmDescriptor } from "./descriptor";

/**
 * Server registration of Raydium CLMM (E3). Lazy adapter so other routes do not bundle it.
 * `enabled` is always false: the generic `/api/dex/[dex]/[op]` route 404s for every Raydium
 * op, in every deploy target, without loading the adapter. Existing app/MCP transports
 * use the lazy full-build binding below. Listing stays on the inline `/app` wallet scan.
 */
export const raydiumClmmModule: DexModule = Object.freeze({
  descriptor: raydiumClmmDescriptor,
  readCronTokenIcons: async input => (await import("./cron-icons.server")).readRaydiumCronIcons(input),
  poolSource: Object.freeze({ order: 0, load: async () => (await import("@/lib/pool-sources/raydium")).raydiumPoolSource }),
  lpPlanReads: Object.freeze({
    observations: async (...args: Parameters<NonNullable<DexModule["lpPlanReads"]>["observations"]>) => (await import("./lp-observations.server")).readDecisionObservations(...args),
    exitPreview: async (...args: Parameters<NonNullable<DexModule["lpPlanReads"]>["exitPreview"]>) => (await import("./lp-exit-preview.server")).readRaydiumLpExitPreview(...args),
  }),
  discoverWallet: async (...args: Parameters<NonNullable<DexModule["discoverWallet"]>>) => (await import("./wallet-read.server")).discoverRaydiumWallet(...args),
  positionReads: Object.freeze({
    source: "raydium" as const, order: 2,
    enabled: () => true,
    matches: async () => true,
    performance: async (...args: Parameters<NonNullable<DexModule["positionReads"]>["performance"]>) => (await import("./position-reads.server")).readRaydiumPerformance(...args),
    range: async (positionMint: string) => (await import("./position-reads.server")).readRaydiumRange(positionMint),
  }),
  adapter: async () => (await import("./adapter.server")).createRaydiumClmmAdapter(),
  buildAdd: async (command, options) => (await import("./build-add.server")).buildRaydiumAdd(command, options),
  buildWithdrawal: async (command, preview) => (await import("./build-withdraw.server")).buildRaydiumWithdrawal(command, preview),
  buildCompound: async command => (await import("./build-compound.server")).buildRaydiumCompound(command),
  buildCompoundRecovery: async command => (await import("./build-compound-recovery.server")).buildRaydiumCompoundRecovery(command),
  buildOpen: async (command, options) => (await import("./build-open.server")).buildRaydiumOpen(command, options),
  quoteOpen: async (command, profile) => (await import("./quote-open.server")).quoteRaydiumOpen(command, profile),
  buildSolSwapStep: async command => (await import("./sol-swap-step.server")).buildRaydiumSolSwapStep(command),
  readSolSwapDelivery: async command => (await import("./sol-swap-step.server")).readRaydiumSolSwapDelivery(command),
  quoteAdd: async (command, context) => (await import("./quote-add.server")).quoteRaydiumAdd(command, context),
  readAddState: async command => (await import("./read-add-state.server")).readRaydiumAddState(command),
  validateSignedAdd: async (command, connection, profile) => (await import("./validate-add.server")).validateRaydiumSignedAdd(command, connection, profile),
  readCompoundState: async (command, connection) => (await import("./read-compound-state.server")).readRaydiumCompoundState(command, connection),
  confirmCompound: async (command, connection) => (await import("./confirm-compound.server")).confirmRaydiumCompound(command, connection),
  importCompoundReceipt: async (command, connection) => (await import("./import-compound.server")).importRaydiumCompoundReceipt(command, connection),
  readWithdrawalStatus: async command => (await import("./withdraw-status.server")).readRaydiumWithdrawalStatus(command),
  enabled: () => false,
  preparePortfolio: async (input, signal) => (await import("./portfolio.server")).prepareRaydiumPortfolio(input, signal),
});
