/** Readback of existing permit-bound withdrawals, independent of new withdrawal preparation. */
import type { WithdrawPrepared, WithdrawSummary } from "@sofinance/engine/withdraw/types";
export type WithdrawalStatusCommand = { signature: string; prepared: WithdrawPrepared };
export type WithdrawalStatusResult = { status: "pending" | "failed" | "expired" | "success" | "manual-review";
  signature: string; stage?: WithdrawSummary["stage"] };
export type ReadWithdrawalStatus = (command: WithdrawalStatusCommand) => Promise<WithdrawalStatusResult>;
