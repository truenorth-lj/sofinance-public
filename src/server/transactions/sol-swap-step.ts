import "@/lib/engine-host";
import "server-only";
import bs58 from "bs58";
import { buildAndSimulateSolSwapStep, isSolSwapCreditSpent, readSolSwapDelivery } from "@sofinance/engine/sol-swap-step";
import { parseTokenAmount } from "@sofinance/engine/amount";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { issueSolSwapPermit } from "@/lib/sol-swap-permit";
import { assertSolInputAllowed } from "@/lib/sol-input-policy";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { txPermitsFor } from "@/lib/tx-send/permit";

/** How long after step 1 lands a step-2 open may still skip the (already paid) fee. */
export const SOL_SWAP_FEE_CREDIT_MS = 30 * 60_000;

export async function prepareSolSwapStep(wallet: string, poolId: string, amount: string) {
  assertSolInputAllowed({ inputKind: "native" });
  const { summary, transaction } = await withFeeEstimateRetry(() => buildAndSimulateSolSwapStep(wallet, poolId, amount));
  const secret = getSigningSecret();
  const permit = issueSolSwapPermit(secret, {
    wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary,
  });
  return { summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"), ...txPermitsFor(wallet, Buffer.from(transaction.serialize()).toString("base64"), summary.lastValidBlockHeight, secret) };
}

export async function readSolSwapStepStatus(wallet: string, signature: string, outputMint: string, lastValidBlockHeight?: number) {
  return readSolSwapDelivery({ signature, wallet, outputMint, lastValidBlockHeight });
}

/** Shown when a step-1 swap's tokens were already deposited (or moved) after the swap. */
export const SOL_SWAP_CREDIT_USED_MESSAGE =
  "This SOL swap was already used for an open. To deposit more, open with the tokens as a normal deposit (the usual fee applies).";

/**
 * Step 2/2 fee credit: the open skips its fee only when the step-1 swap is confirmed, paid by this wallet,
 * paid the protocol fee due on what it swapped (from the transaction's balances), is recent, delivered at
 * least the amount this open deposits, and its tokens have not been moved since (single use, checked
 * on-chain; a cancelled or failed step 2 moves nothing, so it can be retried). Returns the swap's slot so
 * step 2 never simulates against state from before the swap landed.
 */
export async function assertSolSwapFeeCredit(wallet: string, signature: string, inputMint: string, amount: string) {
  if (typeof signature !== "string" || bs58.decode(signature).length !== 64) throw new Error("Invalid step-1 swap signature");
  const delivery = await readSolSwapDelivery({ signature, wallet, outputMint: inputMint });
  if (delivery.status !== "confirmed") throw new Error("Step 1/2 swap is not confirmed yet");
  if (!delivery.feeAccountPaid) throw new Error("Step 1/2 swap did not pay the full protocol fee, so this open can't skip its fee. Open with the tokens as a normal deposit.");
  if (delivery.blockTime !== null && Date.now() - delivery.blockTime * 1000 > SOL_SWAP_FEE_CREDIT_MS) {
    throw new Error("Step 1/2 swap is too old to continue; open with the tokens as a normal deposit");
  }
  if (parseTokenAmount(amount, delivery.decimals) > BigInt(delivery.delivered)) {
    throw new Error("Open amount exceeds what the step 1/2 swap delivered");
  }
  // Last: the only check that reads more than the swap itself.
  if (await isSolSwapCreditSpent({ signature, wallet, outputMint: inputMint, outputAccounts: delivery.outputAccounts })) {
    throw new Error(SOL_SWAP_CREDIT_USED_MESSAGE);
  }
  return { slot: delivery.slot };
}
