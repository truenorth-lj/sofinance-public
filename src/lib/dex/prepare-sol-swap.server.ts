import "@/lib/engine-host";
import "server-only";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { issueSolSwapPermit } from "@/lib/sol-swap-permit";
import { assertSolInputAllowed } from "@/lib/sol-input-policy";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { txPermitsFor } from "@/lib/tx-send/permit";
import { dexRegistry } from "./registry-instance";

export async function prepareSolSwapStep(id: string, wallet: string, poolId: string, amount: string) {
  assertSolInputAllowed({ inputKind: "native" });
  const { summary, transaction } = await withFeeEstimateRetry(() => dexRegistry.buildSolSwapStep(id, { wallet, poolId, amount }));
  const secret = getSigningSecret();
  const permit = issueSolSwapPermit(secret, { wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary });
  const unsignedTransaction = Buffer.from(transaction.serialize()).toString("base64");
  return { summary, permit, unsignedTransaction, ...txPermitsFor(wallet, unsignedTransaction, summary.lastValidBlockHeight, secret) };
}

export async function readSolSwapStepStatus(id: string, wallet: string, signature: string, outputMint: string, lastValidBlockHeight?: number) {
  return dexRegistry.readSolSwapDelivery(id, { signature, wallet, outputMint, lastValidBlockHeight });
}
