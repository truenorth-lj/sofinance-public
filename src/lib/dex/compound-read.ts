/** Compatibility DTOs for native yield reads; no generic trading capability is implied. */
import type { Connection } from "@solana/web3.js";
import type { CompoundAttempt, CompoundReceipt } from "@sofinance/engine/compound-attempt";
import type { CompoundChainStatus, CompoundPositionState } from "@sofinance/engine/compound-types";
import type { confirmedCompoundReceipt } from "@/lib/compound-receipt";
export type CompoundReadCommand = { wallet: string; positionMint: string };
export type CompoundConfirmCommand = { wallet: string; attempt: CompoundAttempt };
export type CompoundImportCommand = { wallet: string; signature: string };
export type CompoundConfirmationResult = {
  signature: string; state: CompoundPositionState | null;
  status: "pending" | "success" | "failed" | "expired" | "manual-review";
  chainStatus: CompoundChainStatus;
  receipt?: ReturnType<typeof confirmedCompoundReceipt>;
  transactionError?: unknown;
};
export type ReadCompoundState = (command: CompoundReadCommand, connection: Connection) => Promise<CompoundPositionState>;
export type ConfirmCompound = (command: CompoundConfirmCommand, connection: Connection) => Promise<CompoundConfirmationResult>;
export type ImportCompoundReceipt = (command: CompoundImportCommand, connection: Connection) => Promise<CompoundReceipt>;
