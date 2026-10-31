import "@/lib/engine-host";
import "server-only";
import bs58 from "bs58";
import { buildAndSimulateSolSwapStep, readSolSwapDelivery } from "@sofinance/engine/sol-swap-step";
import { parseTokenAmount } from "@sofinance/engine/amount";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { issueSolSwapPermit } from "@/lib/sol-swap-permit";
import { assertSolInputAllowed } from "@/lib/sol-input-policy";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";

/** How long after step 1 lands a step-2 open may still skip the (already paid) fee. */
export const SOL_SWAP_FEE_CREDIT_MS = 30 * 60_000;

export async function prepareSolSwapStep(wallet: string, poolId: string, amount: string) {
  assertSolInputAllowed({ inputKind: "native" });
  const { summary, transaction } = await withFeeEstimateRetry(() => buildAndSimulateSolSwapStep(wallet, poolId, amount));
  const permit = issueSolSwapPermit(getSigningSecret(), {
    wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary,
  });
  return { summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64") };
}

export async function readSolSwapStepStatus(wallet: string, signature: string, outputMint: string, lastValidBlockHeight?: number) {
  return readSolSwapDelivery({ signature, wallet, outputMint, lastValidBlockHeight });
}

/**
 * Step 2/2 fee credit. Cheap sanity checks only (product decision: no
 * server-side anti-tampering on fees): the step-1 swap is confirmed, paid by
 * this wallet, wrote the protocol fee account, is recent, and delivered at
 * least the amount this open deposits. Returns the swap's slot so step 2
 * never simulates against state from before the swap landed.
 */
export async function assertSolSwapFeeCredit(wallet: string, signature: string, inputMint: string, amount: string) {
  if (typeof signature !== "string" || bs58.decode(signature).length !== 64) throw new Error("Invalid step-1 swap signature");
  const delivery = await readSolSwapDelivery({ signature, wallet, outputMint: inputMint });
  if (delivery.status !== "confirmed") throw new Error("Step 1/2 swap is not confirmed yet");
  if (!delivery.feeAccountPaid) throw new Error("Step 1/2 swap did not pay the protocol fee");
  if (delivery.blockTime !== null && Date.now() - delivery.blockTime * 1000 > SOL_SWAP_FEE_CREDIT_MS) {
    throw new Error("Step 1/2 swap is too old to continue; open with the tokens as a normal deposit");
  }
  if (parseTokenAmount(amount, delivery.decimals) > BigInt(delivery.delivered)) {
    throw new Error("Open amount exceeds what the step 1/2 swap delivered");
  }
  return { slot: delivery.slot };
}
