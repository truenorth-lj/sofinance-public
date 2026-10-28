import "@/lib/engine-host";
import "server-only";
import { invalidatePositionHistoryCache } from "./position-history-cache";

import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { CompoundSendError } from "./public-error";
import { verifyOpenPositionPermit } from "./open-permit";
import { readOpenPoolState } from "@sofinance/engine/open-state";
import { simulateAndVerifyOpenTransaction } from "@sofinance/engine/open-simulation";
import { rpcConnection } from "@sofinance/engine/rpc";
import { beamAfterSend, noBeamAfterSend } from "@/lib/beam-after-send";
import type { OpenPositionSummary } from "@sofinance/engine/open-types";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { exceedsTxSizeLimit, isZeroSignature } from "@sofinance/engine/transaction-limits";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";
import { logPositionOpenBestEffort, positionOpenRowFromSummary } from "@/lib/opens-log";


export async function sendSignedOpenPosition(
  walletAddress: string,
  transaction: VersionedTransaction,
  summary: OpenPositionSummary,
  sourceRef?: unknown,
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
    const keys = transaction.message.staticAccountKeys;
    const mintIndex = keys.findIndex((key) => key.equals(nftMint));
    const walletSignature = transaction.signatures[0];
    const nftSignature = mintIndex >= 0 ? transaction.signatures[mintIndex] : undefined;
    if (exceedsTxSizeLimit(transaction.serialize().length)) {
      throw new Error("Wallet additions exceed the 1,232 byte transaction limit");
    }
    if (
      keys[0]?.toBase58() !== walletAddress ||
      mintIndex < 1 || mintIndex >= transaction.message.header.numRequiredSignatures ||
      transaction.message.header.numRequiredSignatures < 2 ||
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
    // The retrying RPC exposes only its last error. Even a preflight rejection
    // may follow an accepted send whose response was lost; keep the original
    // signature pending until reconciliation establishes its outcome.
    throw new CompoundSendError(error);
  }
  // Conservatively evict on accepted broadcast; this is not finality proof.
  invalidatePositionHistoryCache(summary.nftMint);
  // Landing metadata is optional: it cannot overturn an accepted submission,
  // and it must not delay the response (no lookup when no tip was included).
  const beam = await beamAfterSend(signature, summary.beam).catch(() => noBeamAfterSend(signature));
  logPositionOpenBestEffort(positionOpenRowFromSummary({
    signature, wallet: walletAddress, summary, sourceRef,
  }));
  return {
    signature, positionMint: summary.nftMint, positionAccount: summary.positionAccount,
    beam: beam.beam, beamLabel: beam.label, beamLandingUrl: beam.beamLandingUrl,
  };
}

export async function submitOpenPositionFromParts(input: {
  signedTransaction: string;
  unsignedTransaction?: string;
  permit: string;
  wallet: string;
  summary: OpenPositionSummary;
  sourceRef?: unknown;
}) {
  const transaction = VersionedTransaction.deserialize(Buffer.from(input.signedTransaction, "base64"));
  const prepared = input.unsignedTransaction
    ? VersionedTransaction.deserialize(Buffer.from(input.unsignedTransaction, "base64"))
    : transaction;
  if (!verifyOpenPositionPermit(getSigningSecret(), {
    wallet: input.wallet,
    message: Buffer.from(prepared.message.serialize()).toString("base64"),
    summary: input.summary,
  }, input.permit)) {
    throw new Error("Transaction does not match simulated open-position authorization");
  }
  if (input.unsignedTransaction) assertWalletReturnedTransaction(prepared, transaction, input.wallet);
  return sendSignedOpenPosition(input.wallet, transaction, input.summary, input.sourceRef);
}
