/** Native compound compatibility bindings; generic StepResult support has a separate rollout. */
import type { VersionedTransaction } from "@solana/web3.js";
import type { CompoundSummary } from "@sofinance/engine/compound-types";
import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
export const APP_COMPOUND_PREPARE = "app-compound";
export const MCP_COMPOUND_PREPARE = "mcp-compound";
export type CompoundPrepareCommand = { wallet: string; positionMint: string; sourceSignatures: string[] };
export type CompoundPrepareProfile = typeof APP_COMPOUND_PREPARE | typeof MCP_COMPOUND_PREPARE;
export type BuildCompound = (command: CompoundPrepareCommand) => Promise<{ summary: CompoundSummary; transaction: VersionedTransaction }>;
export type CompoundRecoveryCommand = { wallet: string; compoundAccounts: unknown };
export type BuildCompoundRecovery = (command: CompoundRecoveryCommand) => Promise<
  { summary: CompoundRecoverySummary; transaction: VersionedTransaction } | { alreadyClosed: true; wallet: string; accounts: string[] }>;
