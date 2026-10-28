import "@/lib/engine-host";
import { submitSelected } from "@/server/transactions/selected-submit";
import { APP_SELECTED_SUBMIT } from "@/server/transactions/surface-policy";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { parseWallet } from "@sofinance/engine/api-input";
import { apiError } from "@/lib/api-response";
import { verifySelectedPermit, type SelectedPermitInput } from "@/lib/selected-permit";
import { beamLandingUrl } from "@sofinance/engine/solami-beam";
import nacl from "tweetnacl";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { isSingleWalletSignedTransaction } from "@sofinance/engine/transaction-limits";
import { assertWalletReturnedTransaction } from "@sofinance/engine/wallet-returned-tx";

function validRaw(value: unknown) {
  return typeof value === "string" && /^\d+$/.test(value);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as SelectedPermitInput & { signedTransaction: string; permit: string };
    const walletAddress = parseWallet(body.wallet);
    if (!body.selection || typeof body.selection.positionMint !== "string" ||
      typeof body.selection.inputMint !== "string" ||
      (body.selection.inputKind !== "native" && body.selection.inputKind !== "token") ||
      new PublicKey(body.selection.positionMint).toBase58() !== body.selection.positionMint ||
      new PublicKey(body.selection.inputMint).toBase58() !== body.selection.inputMint ||
      typeof body.signedTransaction !== "string" || body.signedTransaction.length > 2_500 ||
      typeof body.permit !== "string" || !validRaw(body.requested) ||
      !validRaw(body.expectedLiquidity) || !validRaw(body.startingLiquidity) ||
      BigInt(body.requested) <= 0n || BigInt(body.expectedLiquidity) <= 0n ||
      !Number.isSafeInteger(body.floorBps) || body.floorBps < 9_500 || body.floorBps > 10_000 ||
      body.floorBps % 10 !== 0 || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= Date.now() ||
      !Number.isSafeInteger(body.lastValidBlockHeight) || body.lastValidBlockHeight <= 0 ||
      !body.startingBalances || !validRaw(body.startingBalances.input) ||
      !validRaw(body.startingBalances.a) || !validRaw(body.startingBalances.b) ||
      !["below", "inside", "above"].includes(body.rangeSide)) throw new Error("Invalid or expired signed transaction input");
    const wallet = new PublicKey(walletAddress);
    const transaction = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
    const prepared = typeof (body as { unsignedTransaction?: string }).unsignedTransaction === "string"
      ? VersionedTransaction.deserialize(Buffer.from((body as { unsignedTransaction: string }).unsignedTransaction, "base64"))
      : transaction;
    const walletSignature = transaction.signatures[0];
    if (!isSingleWalletSignedTransaction(transaction, walletAddress) || !walletSignature) {
      throw new Error("Payer, signature count, or transaction size mismatch");
    }
    if (prepared !== transaction) assertWalletReturnedTransaction(prepared, transaction, walletAddress);
    const permitInput: SelectedPermitInput = {
      message: Buffer.from(prepared.message.serialize()).toString("base64"), wallet: walletAddress,
      selection: body.selection, requested: body.requested, floorBps: body.floorBps,
      expiresAt: body.expiresAt, lastValidBlockHeight: body.lastValidBlockHeight,
      startingLiquidity: body.startingLiquidity, expectedLiquidity: body.expectedLiquidity,
      rangeSide: body.rangeSide, startingBalances: body.startingBalances,
    };
    if (!verifySelectedPermit(getSigningSecret(), permitInput, body.permit)) {
      throw new Error("Transaction content does not match server's complete simulation version");
    }
    if (!nacl.sign.detached.verify(transaction.message.serialize(), walletSignature, wallet.toBytes())) {
      throw new Error("Wallet signature does not match the prepared transaction");
    }
    const signature = await submitSelected({ transaction, wallet, walletSignature, permitInput }, APP_SELECTED_SUBMIT);
    return Response.json(
      { signature, beam: null, beamLabel: null, beamLandingUrl: beamLandingUrl(signature) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error, "Transaction broadcast failed");
  }
}
