import type { AtomicStatus } from "@/lib/attempt-status";
import type { CompoundChainStatus } from "@sofinance/engine/compound-types";

/** A saved compound or recovery attempt as `/api/compound-confirm` last reported it. */
export type AttemptResolution = { signature: string; status: AtomicStatus; chainStatus?: CompoundChainStatus };

/** success, failed and expired are final; pending and manual-review are not. */
export const isSettledStatus = (status: AtomicStatus) => status === "success" || status === "failed" || status === "expired";

/**
 * A new Raydium compound, recovery or cleanup may start only once the saved attempt settled and Solana agrees (the row's
 * Compound, the cleanup batch and compound all share this admission).
 */
export function recoveryMayProceed(value: Pick<AttemptResolution, "status" | "chainStatus"> | null) {
  return !!value && isSettledStatus(value.status) && (value.chainStatus === undefined || value.chainStatus === value.status);
}
