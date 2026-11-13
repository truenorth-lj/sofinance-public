import "@/lib/engine-host";
import "server-only";
import { buildAndSimulateSolSwapStep, readSolSwapDelivery } from "@sofinance/engine/sol-swap-step";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { issueSolSwapPermit } from "@/lib/sol-swap-permit";
import { assertSolInputAllowed } from "@/lib/sol-input-policy";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { txPermitsFor } from "@/lib/tx-send/permit";

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
