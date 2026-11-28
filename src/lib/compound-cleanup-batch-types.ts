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
  /**
   * Whether the confirming RPC has seen the signature at all. `false` means it is not on Solana (yet), so the client
   * may send the same signed transaction again while its blockhash is valid. Omitted when the RPC could not answer.
   */
  onChain?: boolean;
};
