import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
import type { AtomicStatus } from "./attempt-status";
import type { CompoundChainStatus } from "@sofinance/engine/compound-types";

export type CleanupBatchPreparedTransaction = {
  summary: CompoundRecoverySummary;
  permit: string;
  unsignedTransaction: string;
};
export type CleanupBatchPrepared = {
  wallet: string;
  alreadyClosed: string[];
  transactions: CleanupBatchPreparedTransaction[];
};
export type CleanupBatchConfirmation = {
  signature: string;
  status: AtomicStatus;
  chainStatus: CompoundChainStatus;
};
