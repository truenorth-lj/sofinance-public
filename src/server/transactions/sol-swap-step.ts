import "@/lib/engine-host";
import "server-only";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { buildAndSimulateSolSwapStep, readSolSwapDelivery, type SolSwapStepSummary } from "@sofinance/engine/sol-swap-step";
import { parseTokenAmount } from "@sofinance/engine/amount";
import { rpcConnection } from "@sofinance/engine/rpc";
import { exceedsTxSizeLimit, isZeroSignature } from "@sofinance/engine/transaction-limits";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { issueSolSwapPermit, verifySolSwapPermit } from "@/lib/sol-swap-permit";
import { assertSolInputAllowed } from "@/lib/sol-input-policy";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";
import { CompoundSendError } from "@/lib/public-error";
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

export async function sendSignedSolSwapStep(input: {
  signedTransaction: string; unsignedTransaction: string; permit: string; wallet: string; summary: SolSwapStepSummary;
}) {
  const connection = rpcConnection();
  let signed: VersionedTransaction;
  try {
    signed = VersionedTransaction.deserialize(Buffer.from(input.signedTransaction, "base64"));
    const prepared = VersionedTransaction.deserialize(Buffer.from(input.unsignedTransaction, "base64"));
    const { summary, wallet } = input;
    if (!verifySolSwapPermit(getSigningSecret(), {
      wallet, message: Buffer.from(prepared.message.serialize()).toString("base64"), summary,
    }, input.permit)) throw new Error("Transaction does not match the simulated SOL swap authorization");
    if (summary.operation !== "sol-swap-step" || summary.wallet !== wallet || summary.expiresAt <= Date.now() ||
      summary.blockhash !== signed.message.recentBlockhash) {
      throw new Error("SOL swap authorization type, wallet, or expiry mismatch");
    }
    assertWalletReturnedTransaction(prepared, signed, wallet);
    const walletKey = new PublicKey(wallet);
    const signature = signed.signatures[0];
    if (signed.message.header.numRequiredSignatures !== 1 || signed.message.staticAccountKeys[0]?.toBase58() !== wallet ||
      exceedsTxSizeLimit(signed.serialize().length) || isZeroSignature(signature) ||
      !nacl.sign.detached.verify(signed.message.serialize(), signature!, walletKey.toBytes())) {
      throw new Error("SOL swap payer, signature, or transaction size mismatch");
    }
    if (await connection.getBlockHeight("confirmed") > summary.lastValidBlockHeight) throw new Error("Transaction blockhash expired");
  } catch (error) {
    throw new CompoundSendError(error, false);
  }
  const expected = bs58.encode(signed.signatures[0]!);
  try {
    const sent = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    if (sent !== expected) throw new Error("RPC returned transaction signature mismatch");
  } catch (error) {
    // A lost response may follow an accepted send; the client keeps polling the signature.
    throw new CompoundSendError(error);
  }
  return { signature: expected };
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
