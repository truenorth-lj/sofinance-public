import "server-only";
import { invalidatePositionHistoryCache } from "./position-history-cache";

import { PublicKey, SendTransactionError, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { CompoundSendError } from "./public-error";
import { verifyOpenPositionPermit } from "./open-permit";
import { readOpenPoolState } from "./open-state";
import { simulateAndVerifyOpenTransaction } from "./open-simulation";
import { rpcConnection } from "./rpc";
import { beamLandingUrl, lookupBeamAfterSend } from "./solami-beam";
import type { OpenPositionSummary } from "./open-types";
import { getSigningSecret } from "./config/server-env";
import { exceedsTxSizeLimit, isZeroSignature } from "./transaction-limits";


export async function sendSignedOpenPosition(
  walletAddress: string,
  transaction: VersionedTransaction,
  summary: OpenPositionSummary,
) {
  let connection: ReturnType<typeof rpcConnection>;
  try {
    if (summary.operation !== "open-position" || !Number.isSafeInteger(summary.expiresAt) ||
      summary.expiresAt <= Date.now() || !Number.isSafeInteger(summary.lastValidBlockHeight) ||
      summary.lastValidBlockHeight <= 0 || summary.blockhash !== transaction.message.recentBlockhash ||
      summary.wallet !== walletAddress || summary.quote.wallet !== walletAddress) {
      throw new Error("Open-position authorization type, wallet, or expiry mismatch");
    }
    const wallet = new PublicKey(walletAddress);
    const nftMint = new PublicKey(summary.nftMint);
    const message = transaction.message.serialize();
    const walletSignature = transaction.signatures[0];
    const nftSignature = transaction.signatures[1];
    if (
      exceedsTxSizeLimit(transaction.serialize().length) ||
      transaction.message.staticAccountKeys[0]?.toBase58() !== walletAddress ||
      transaction.message.staticAccountKeys[1]?.toBase58() !== summary.nftMint ||
      transaction.message.header.numRequiredSignatures !== 2 ||
      transaction.signatures.length !== 2 ||
      isZeroSignature(walletSignature) || isZeroSignature(nftSignature)
    ) {
      throw new Error("Open-position payer, NFT mint signature, or transaction size mismatch");
    }
    if (!nacl.sign.detached.verify(message, nftSignature!, nftMint.toBytes())) {
      throw new Error("Position NFT mint partial signature is invalid");
    }
    if (!nacl.sign.detached.verify(message, walletSignature!, wallet.toBytes())) {
      throw new Error("Wallet signature is invalid");
    }
    connection = rpcConnection();
    const [height, state] = await Promise.all([
      connection.getBlockHeight("confirmed"),
      readOpenPoolState(walletAddress, {
        poolId: summary.poolId,
        inputMint: summary.inputMint,
        inputKind: summary.inputKind,
      }, connection),
    ]);
    if (height > summary.lastValidBlockHeight) throw new Error("Transaction blockhash expired");
    if (state.paused || state.frozen || state.transferFee || state.unsupportedExtensions.length ||
      !state.sufficientSol || state.poolId !== summary.poolId ||
      state.inputMint !== summary.inputMint || state.inputKind !== summary.inputKind ||
      state.balances.input !== summary.startingBalances.input ||
      state.balances.a !== summary.startingBalances.a ||
      state.balances.b !== summary.startingBalances.b) {
      throw new Error("Pool, wallet balance, or asset flags have changed since preparation");
    }
    await simulateAndVerifyOpenTransaction({
      connection, transaction, wallet, state, nftMint,
      tickLower: summary.tickLower, tickUpper: summary.tickUpper,
      requested: BigInt(summary.quote.requested),
      expectedLiquidity: BigInt(summary.quote.liquidity),
      maxSolDebitLamports: BigInt(summary.maxSolDebitLamports),
      sigVerify: true,
    });
    if (Date.now() >= summary.expiresAt || await connection.getBlockHeight("confirmed") > summary.lastValidBlockHeight) {
      throw new Error("Signed transaction expired before broadcast");
    }
  } catch (error) {
    throw new CompoundSendError(error, false);
  }
  const expectedSignature = bs58.encode(transaction.signatures[0]!);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    if (signature !== expectedSignature) throw new Error("RPC returned transaction signature mismatch");
  } catch (error) {
    // web3 wraps other RPC errors as SendTransactionError too. Only the
    // explicit simulation rejection proves that this submission was not sent.
    const rejected = error instanceof SendTransactionError &&
      /^Transaction simulation failed(?:\s*:|$)/i.test(error.transactionError.message);
    throw new CompoundSendError(error, rejected ? false : undefined);
  }
  // Conservatively evict on accepted broadcast; this is not finality proof.
  invalidatePositionHistoryCache(summary.nftMint);
  // Landing metadata is optional: it cannot overturn an accepted submission.
  const beam = await lookupBeamAfterSend(signature).catch(() => null);
  return {
    signature, positionMint: summary.nftMint, positionAccount: summary.positionAccount,
    beam: beam?.beam ?? null, beamLabel: beam?.label ?? null,
    beamLandingUrl: beam?.beamLandingUrl ?? beamLandingUrl(signature),
  };
}

export async function submitOpenPositionFromParts(input: {
  signedTransaction: string;
  permit: string;
  wallet: string;
  summary: OpenPositionSummary;
}) {
  const transaction = VersionedTransaction.deserialize(Buffer.from(input.signedTransaction, "base64"));
  if (!verifyOpenPositionPermit(getSigningSecret(), {
    wallet: input.wallet,
    message: Buffer.from(transaction.message.serialize()).toString("base64"),
    summary: input.summary,
  }, input.permit)) {
    throw new Error("Transaction does not match simulated open-position authorization");
  }
  return sendSignedOpenPosition(input.wallet, transaction, input.summary);
}
