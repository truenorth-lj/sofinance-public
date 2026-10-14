import { simulateAndVerifySelectedTransaction } from "@/lib/selected-simulation";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { parseWallet } from "@/lib/api-input";
import { apiError } from "@/lib/api-response";
import { verifySelectedPermit, type SelectedPermitInput } from "@/lib/selected-permit";
import { readSelectedPositionState } from "@/lib/selected-state";
import { rpcConnection } from "@/lib/rpc";
import { beamLandingUrl } from "@/lib/solami-beam";
import nacl from "tweetnacl";
import { getSigningSecret } from "@/lib/config/server-env";
import { isSingleWalletSignedTransaction } from "@/lib/transaction-limits";

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
    const walletSignature = transaction.signatures[0];
    if (!isSingleWalletSignedTransaction(transaction, walletAddress) || !walletSignature) {
      throw new Error("Payer, signature count, or transaction size mismatch");
    }
    const permitInput: SelectedPermitInput = {
      message: Buffer.from(transaction.message.serialize()).toString("base64"), wallet: walletAddress,
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
    const connection = rpcConnection();
    const [height, state] = await Promise.all([
      connection.getBlockHeight("confirmed"),
      readSelectedPositionState(walletAddress, body.selection, connection, false, { displayPrices: false }),
    ]);
    if (height > body.lastValidBlockHeight) throw new Error("Transaction blockhash expired");
    if (state.inputKind === "native" && state.wsolBalance !== "0") throw new Error("Native SOL input already has WSOL ATA balance, please handle separately to avoid using existing WSOL");
    if (!state.ownsNft || state.paused || state.frozen || state.transferFee ||
      state.unsupportedExtensions.length || !state.sufficientSol ||
      state.positionMint !== body.selection.positionMint ||
      state.inputMint !== body.selection.inputMint || state.inputKind !== body.selection.inputKind ||
      state.liquidity !== body.startingLiquidity || state.rangeSide !== body.rangeSide ||
      state.balances.input !== body.startingBalances.input ||
      state.balances.a !== body.startingBalances.a || state.balances.b !== body.startingBalances.b) {
      throw new Error("Selected NFT, range, liquidity, or wallet balance has changed");
    }
    // The exact signed message is simulated against the fresh snapshot to
    // preserve debit/reserve guarantees even when rent/refunds changed.
    await simulateAndVerifySelectedTransaction({
      connection, transaction, wallet, state, requested: BigInt(body.requested),
      expectedLiquidity: BigInt(body.expectedLiquidity), sigVerify: true, useStateSnapshot: true,
    });
    if (Date.now() >= body.expiresAt || await connection.getBlockHeight("confirmed") > body.lastValidBlockHeight) {
      throw new Error("Signed transaction expired before broadcast");
    }
    const expectedSignature = bs58.encode(walletSignature);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    if (signature !== expectedSignature) throw new Error("Dedicated RPC returned transaction signature mismatch");
    return Response.json(
      { signature, beam: null, beamLabel: null, beamLandingUrl: beamLandingUrl(signature) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error, "Transaction broadcast failed");
  }
}
