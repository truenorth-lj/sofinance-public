import "@/lib/engine-host";
import { VersionedTransaction } from "@solana/web3.js";
import { buildAndSimulateCompound } from "@sofinance/engine/compound-atomic";
import { prepareCompound } from "@/server/transactions/compound-prepare";
import { MCP_COMPOUND_PREPARE } from "@/server/transactions/surface-policy";
import { verifyCompoundPermit } from "../../lib/compound-permit";
import { sendSignedCompoundTransaction } from "../../lib/compound-send";
import { CompoundSendError, notSentRetryMessage, sanitizePublicError } from "../../lib/public-error";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import type { CompoundSummary } from "@sofinance/engine/compound-types";
import { createSignToken } from "../../lib/pending-sign-token";
import { buildSignUrl } from "../../lib/public-urls";
import { isSingleWalletSignedTransaction } from "@sofinance/engine/transaction-limits";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";
import type { QuoteCompoundInput, SubmitCompoundTransactionInput } from "../schemas";
import { capturePrepareSigningSecret } from "./prepare-secret";

/**
 * Get a quote for compounding (harvesting and reinvesting) a position's fees.
 * Includes swap plan, expected liquidity increase, and simulation results.
 * 
 * Safety: Read-only, verifies position eligibility, simulates harvest+swap+add.
 * Failure modes: Ineligible position, third reward token, insufficient harvested fees.
 */
export async function quoteCompound(input: QuoteCompoundInput) {
  const { summary } = await buildAndSimulateCompound(
    input.wallet,
    input.positionMint,
    input.sourceSignatures || [],
  );
  
  // Return only public summary data
  return {
    operation: summary.operation,
    simulated: summary.simulated,
    positionMint: summary.positionMint,
    positionAccount: summary.positionAccount,
    poolId: summary.poolId,
    startingLiquidity: summary.startingLiquidity,
    liquidity: summary.liquidity,
    amountMaxA: summary.amountMaxA,
    amountMaxB: summary.amountMaxB,
    swaps: summary.swaps,
    simulatedHarvest: summary.simulatedHarvest,
    simulatedRewards: summary.simulatedRewards,
    simulatedEndingLiquidity: summary.simulatedEndingLiquidity,
    simulatedDustA: summary.simulatedDustA,
    simulatedDustB: summary.simulatedDustB,
    simulatedSolDebitLamports: summary.simulatedSolDebitLamports,
    maxSolDebitLamports: summary.maxSolDebitLamports,
    feeBps: summary.feeBps,
    feeAmount: summary.feeAmount,
    feeWallet: summary.feeWallet,
    feeLamports: summary.feeLamports,
    rentLamports: summary.rentLamports,
    sizeBytes: summary.sizeBytes,
    unitsConsumed: summary.unitsConsumed,
    expiresAt: summary.expiresAt,
    simulatedAt: summary.simulatedAt,
  };
}

/**
 * Prepare an unsigned compound transaction.
 * Returns base64-encoded transaction for signing.
 * 
 * Safety: Same as prepareTransaction, plus isolated yield accounts.
 */
export async function prepareCompoundTransaction(input: QuoteCompoundInput) {
  const signingSecret = capturePrepareSigningSecret();
  const { summary, permit, unsignedTransaction: unsignedTransactionBase64 } = await prepareCompound({
    wallet: input.wallet, positionMint: input.positionMint, sourceSignatures: input.sourceSignatures || [],
  }, signingSecret, MCP_COMPOUND_PREPARE);
  const jupiterApiKey = signingSecret();

  // submitArgs for compound includes signedTransaction, permit, wallet, and full summary
  const submitArgs = {
    permit,
    wallet: input.wallet,
    summary,
  };
  
  // Create self-contained signed token (no shared storage required)
  const signToken = await createSignToken(
    {
      kind: "compound",
      wallet: input.wallet,
      unsignedTransaction: unsignedTransactionBase64,
      permit,
      submitArgs,
      expiresAt: summary.expiresAt,
    },
    jupiterApiKey
  );
  
  const signUrl = buildSignUrl(signToken);

  // The permit is an HMAC over the complete summary, so the complete object
  // must be returned and passed back unchanged to submit_compound_transaction.
  return {
    unsignedTransaction: unsignedTransactionBase64,
    permit,
    summary,
    signToken,
    signUrl,
    instructions: {
      message: "Sign unsignedTransaction with the wallet, then call submit_compound_transaction with { signedTransaction, permit, wallet, summary }. Pass summary back exactly as returned; it is bound by the permit. Or open signUrl in a browser with the wallet connected to sign via UI.",
    },
  };
}


/**
 * Submit a signed compound transaction.
 * Re-verifies permit and summary, then broadcasts.
 * 
 * Safety: Same as submitSignedTransaction.
 */
export async function submitCompoundTransaction(input: SubmitCompoundTransactionInput) {
  try {
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(input.signedTransaction, "base64")
    );
    const prepared = input.unsignedTransaction
      ? VersionedTransaction.deserialize(Buffer.from(input.unsignedTransaction, "base64"))
      : transaction;
    if (prepared !== transaction) assertWalletReturnedTransaction(prepared, transaction, input.wallet);

    const jupiterApiKey = getSigningSecret();
    if (
      !verifyCompoundPermit(
        jupiterApiKey,
        {
          wallet: input.wallet,
          message: Buffer.from(prepared.message.serialize()).toString("base64"),
          summary: input.summary,
        },
        input.permit
      )
    ) {
      throw new Error("Transaction does not match simulated compound authorization");
    }

    if (
      !isSingleWalletSignedTransaction(transaction, input.wallet)
    ) {
      throw new Error("Compound payer, signature, or transaction size mismatch");
    }

    const summary = input.summary as CompoundSummary;
    if (
      summary.operation !== "compound" ||
      !Number.isSafeInteger(summary.expiresAt) ||
      summary.expiresAt <= Date.now() ||
      !Number.isSafeInteger(summary.lastValidBlockHeight) ||
      summary.lastValidBlockHeight <= 0 ||
      summary.blockhash !== transaction.message.recentBlockhash ||
      summary.state?.wallet !== input.wallet
    ) {
      throw new Error("Compound authorization type, wallet, or expiry mismatch");
    }

    return await sendSignedCompoundTransaction(
      input.wallet, transaction, summary, prepared !== transaction ? prepared : undefined,
    );
  } catch (error) {
    if (error instanceof CompoundSendError) {
      const message = sanitizePublicError(error.cause ?? error, "Compound transaction broadcast failed");
      throw new Error(error.sent === false ? notSentRetryMessage(message) : message);
    }
    throw new Error(notSentRetryMessage(sanitizePublicError(error, "Compound transaction broadcast failed")));
  }
}

