/**
 * Open-position wallet steps for Robinhood Chain (design §3.5): first time per token an unlimited
 * `approve(Permit2)` (Uniswap standard), then every open = one Permit2 signature + one `execute`.
 * Progress reads "Step 1/2" (or "1/3" with the first-time approve).
 */

export type OpenStepId = "approve" | "sign" | "execute";
export type OpenStep = { id: OpenStepId; index: number; total: number; label: string; detail: string };

export function openSteps(needsApproval: boolean): OpenStep[] {
  const ids: OpenStepId[] = needsApproval ? ["approve", "sign", "execute"] : ["sign", "execute"];
  const text: Record<OpenStepId, [string, string]> = {
    approve: ["Allow Permit2 for this token (one time)", "Standard Uniswap setup: an unlimited approval to the Permit2 contract, done once per token. Each open still needs its own exact-amount signature."],
    sign: ["Sign the Permit2 permit", "Off-chain signature for exactly this deposit, valid 30 minutes, usable only by the Uniswap Universal Router. No gas."],
    execute: ["Confirm the transaction", "One Universal Router transaction: swap the needed part, open the position (NFT to you) and return any leftover."],
  };
  return ids.map((id, i) => ({ id, index: i + 1, total: ids.length, label: text[id][0], detail: text[id][1] }));
}

export const stepProgressLabel = (step: Pick<OpenStep, "index" | "total">) => `Step ${step.index}/${step.total}`;

/** PM wording (2026-10-29) for the one automatic re-quote after an on-chain revert; same constant the server returns. */
export { REQUOTE_CONFIRM_MESSAGE as RETRY_CONFIRM_TEXT } from "@sofinance/engine/protocols/uniswap-v4/open-constants";
