import "@/lib/engine-host";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { searchSelectedQuoteBundle } from "../../lib/selected-quote";
import { submitSelected } from "@/server/transactions/selected-submit";
import { prepareSelected } from "@/server/transactions/selected-prepare";
import { MCP_SELECTED_PREPARE, MCP_SELECTED_SUBMIT } from "@/server/transactions/surface-policy";
import { verifySelectedPermit } from "../../lib/selected-permit";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { createSignToken } from "../../lib/pending-sign-token";
import { buildSignUrl } from "../../lib/public-urls";
import { isSingleWalletSignedTransaction } from "@sofinance/engine/transaction-limits";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";
import type {
  PrepareTransactionInput,
  QuoteAddLiquidityInput,
  SubmitSignedTransactionInput,
} from "../schemas";
import { capturePrepareSigningSecret } from "./prepare-secret";

/**
 * Get a quote for adding liquidity to a position.
 * Includes swap routes, price impact, resale protection, and estimated outputs.
 * 
 * Safety: Read-only, verifies NFT ownership, pool state, and balance.
 * Failure modes: Insufficient balance, high price impact, quote expiration.
 */
export async function quoteAddLiquidity(input: QuoteAddLiquidityInput) {
  const selection = {
    positionMint: input.positionMint,
    inputMint: input.inputMint,
    inputKind: input.inputKind,
  };
  
  const { quote } = await searchSelectedQuoteBundle(
    input.wallet,
    selection,
    input.amount,
    input.resaleFloorBps,
    input.slippageToleranceBps,
    { buildTransactions: false, includeResale: false },
  );
  
  // Return only essential quote data, omit internal state
  return {
    wallet: quote.wallet,
    inputMint: quote.inputMint,
    inputKind: quote.inputKind,
    inputDecimals: quote.inputDecimals,
    positionMint: quote.positionMint,
    positionAccount: quote.positionAccount,
    poolId: quote.poolId,
    mintA: quote.mintA,
    mintB: quote.mintB,
    decimalsA: quote.decimalsA,
    decimalsB: quote.decimalsB,
    rangeSide: quote.rangeSide,
    requested: quote.requested,
    spendA: quote.spendA,
    spendB: quote.spendB,
    minOutA: quote.minOutA,
    minOutB: quote.minOutB,
    liquidity: quote.liquidity,
    amountMaxA: quote.amountMaxA,
    amountMaxB: quote.amountMaxB,
    requiredA: quote.requiredA,
    requiredB: quote.requiredB,
    slippageToleranceBps: quote.toleranceBps,
    dustA: quote.dustA,
    dustB: quote.dustB,
    resaleInput: quote.resaleInput,
    minimumResaleInput: quote.minimumResaleInput,
    roundtripCostInput: quote.roundtripCostInput,
    projectedPrice: quote.projectedPrice,
    passesFloor: quote.passesFloor,
    floorBps: quote.floorBps,
    suggestedResaleFloorBps: quote.suggestedResaleFloorBps,
    maxAmountForFloor: quote.maxAmountForFloor,
    achievedResaleBps: quote.achievedResaleBps,
    warning: quote.warning || undefined,
    maxImpactBps: quote.maxImpactBps,
    slippageBps: quote.slippageBps,
    routeTouchesTargetPool: quote.routeTouchesTargetPool,
    expiresAt: quote.expiresAt,
    fetchedAt: quote.fetchedAt,
  };
}

/**
 * Prepare an unsigned, simulated transaction for adding liquidity.
 * Returns base64-encoded transaction for the user/agent wallet to sign.
 * 
 * Safety: Full simulation, 1232-byte limit, HMAC permit, re-verification gates.
 * The server never holds private keys. Transaction expires quickly.
 * Failure modes: Simulation failure, size limit, blockhash expiry, state changes.
 */
export async function prepareTransaction(input: PrepareTransactionInput) {
  const signingSecret = capturePrepareSigningSecret();
  const selection = {
    positionMint: input.positionMint,
    inputMint: input.inputMint,
    inputKind: input.inputKind,
  };
  
  const { summary, permit, unsignedTransaction: unsignedTransactionBase64 } = await prepareSelected({
    wallet: input.wallet, selection, amount: input.amount,
    floorBps: input.resaleFloorBps, toleranceBps: input.slippageToleranceBps,
  }, signingSecret, MCP_SELECTED_PREPARE);
  const jupiterApiKey = signingSecret();

  // Every field submit_signed_transaction needs besides the signed transaction.
  // These values are bound by the permit, so they must be passed back unchanged.
  const submitArgs = {
    permit,
    wallet: input.wallet,
    selection,
    requested: summary.quote.requested,
    expectedLiquidity: summary.quote.liquidity,
    startingLiquidity: summary.startingLiquidity,
    floorBps: summary.quote.floorBps,
    expiresAt: summary.expiresAt,
    lastValidBlockHeight: summary.lastValidBlockHeight,
    rangeSide: summary.quote.rangeSide,
    startingBalances: summary.startingBalances,
  };
  
  // Create self-contained signed token (no shared storage required)
  const signToken = await createSignToken(
    {
      kind: "add-liquidity",
      wallet: input.wallet,
      unsignedTransaction: unsignedTransactionBase64,
      permit,
      submitArgs,
      expiresAt: summary.expiresAt,
    },
    jupiterApiKey
  );
  
  const signUrl = buildSignUrl(signToken);

  return {
    unsignedTransaction: unsignedTransactionBase64,
    permit,
    submitArgs,
    signToken,
    signUrl,
    summary: {
      simulated: summary.simulated,
      quote: {
        wallet: summary.quote.wallet,
        inputMint: summary.quote.inputMint,
        inputKind: summary.quote.inputKind,
        positionMint: summary.quote.positionMint,
        poolId: summary.quote.poolId,
        rangeSide: summary.quote.rangeSide,
        requested: summary.quote.requested,
        liquidity: summary.quote.liquidity,
        passesFloor: summary.quote.passesFloor,
        floorBps: summary.quote.floorBps,
        slippageToleranceBps: summary.quote.toleranceBps,
        amountMaxA: summary.quote.amountMaxA,
        amountMaxB: summary.quote.amountMaxB,
        expiresAt: summary.quote.expiresAt,
      },
      sizeBytes: summary.sizeBytes,
      unitsConsumed: summary.unitsConsumed,
      feeLamports: summary.feeLamports,
      lastValidBlockHeight: summary.lastValidBlockHeight,
      blockhash: summary.blockhash,
      startingLiquidity: summary.startingLiquidity,
      startingBalances: summary.startingBalances,
      simulatedEndingLiquidity: summary.simulatedEndingLiquidity,
      simulatedInputSpent: summary.simulatedInputSpent,
      simulatedSolDebitLamports: summary.simulatedSolDebitLamports,
      expiresAt: summary.expiresAt,
    },
    instructions: {
      message: "Sign unsignedTransaction with the wallet, then call submit_signed_transaction with { signedTransaction, ...submitArgs }. Do not modify submitArgs; they are bound by the permit. Or open signUrl in a browser with the wallet connected to sign via UI.",
    },
  };
}

/**
 * Submit a signed add-liquidity transaction.
 * Re-verifies all conditions, simulates, then broadcasts.
 * 
 * Safety: HMAC verification, re-read on-chain state, re-simulate, then broadcast.
 * Failure modes: Permit mismatch, state changed, expired, simulation failure.
 */
export async function submitSignedTransaction(input: SubmitSignedTransactionInput) {
  const walletAddress = input.wallet;
  if (
    BigInt(input.requested) <= 0n ||
    BigInt(input.expectedLiquidity) <= 0n ||
    input.expiresAt <= Date.now()
  ) {
    throw new Error("Invalid or expired signed transaction input");
  }
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(input.signedTransaction, "base64")
  );
  const prepared = input.unsignedTransaction
    ? VersionedTransaction.deserialize(Buffer.from(input.unsignedTransaction, "base64"))
    : transaction;
  if (prepared !== transaction) assertWalletReturnedTransaction(prepared, transaction, walletAddress);

  // Verify permit against the prepared message; the wallet-returned tx is matched semantically.
  const jupiterApiKey = getSigningSecret();
  const permitInput = {
    message: Buffer.from(prepared.message.serialize()).toString("base64"),
    wallet: walletAddress,
    selection: input.selection,
    requested: input.requested,
    floorBps: input.floorBps,
    expiresAt: input.expiresAt,
    lastValidBlockHeight: input.lastValidBlockHeight,
    startingLiquidity: input.startingLiquidity,
    expectedLiquidity: input.expectedLiquidity,
    rangeSide: input.rangeSide,
    startingBalances: input.startingBalances,
  };
  
  if (!verifySelectedPermit(jupiterApiKey, permitInput, input.permit)) {
    throw new Error("Transaction content does not match server's simulation permit");
  }
  
  // Verify transaction structure
  const wallet = new PublicKey(walletAddress);
  const walletSignature = transaction.signatures[0];
  if (
    !isSingleWalletSignedTransaction(transaction, walletAddress) ||
    !walletSignature
  ) {
    throw new Error("Payer, signature count, or transaction size mismatch");
  }
  
  const signature = await submitSelected({
    transaction, wallet, walletSignature, permitInput,
    prepared: prepared !== transaction ? prepared : undefined,
  }, MCP_SELECTED_SUBMIT);

  // Same response shape the app relay (/api/tx-send) returns.
  return { signature };
}

