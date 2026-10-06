import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { parseWallet } from "@/lib/api-input";
import { confirmedAtomicSuccess, instructionLiquidity } from "@/lib/attempt-status";
import { apiError } from "@/lib/api-response";
import { readSelectedPositionState, type PositionSelection } from "@/lib/selected-state";
import { rpcConnection } from "@/lib/rpc";

function validRaw(value: unknown) {
  return typeof value === "string" && /^\d+$/.test(value);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      wallet: string; selection: PositionSelection; poolId: string; positionAccount: string;
      signature: string; startingLiquidity: string; expectedLiquidity: string;
      startingBalances: { input: string; a: string; b: string }; lastValidBlockHeight: number;
    };
    const wallet = parseWallet(body.wallet);
    if (!body.selection || typeof body.selection.positionMint !== "string" ||
      typeof body.selection.inputMint !== "string" ||
      (body.selection.inputKind !== "native" && body.selection.inputKind !== "token") ||
      typeof body.poolId !== "string" || typeof body.positionAccount !== "string" ||
      new PublicKey(body.selection.positionMint).toBase58() !== body.selection.positionMint ||
      new PublicKey(body.selection.inputMint).toBase58() !== body.selection.inputMint ||
      new PublicKey(body.poolId).toBase58() !== body.poolId ||
      new PublicKey(body.positionAccount).toBase58() !== body.positionAccount ||
      typeof body.signature !== "string" || bs58.decode(body.signature).length !== 64 ||
      !validRaw(body.startingLiquidity) || !validRaw(body.expectedLiquidity) ||
      !body.startingBalances || !validRaw(body.startingBalances.input) ||
      !validRaw(body.startingBalances.a) || !validRaw(body.startingBalances.b) ||
      !Number.isSafeInteger(body.lastValidBlockHeight) || body.lastValidBlockHeight <= 0) {
      throw new Error("Invalid transaction verification input");
    }
    const connection = rpcConnection();
    const signatureStatus = await connection.getSignatureStatuses([body.signature], { searchTransactionHistory: true });
    const observed = signatureStatus.value[0];
    let state;
    try {
      state = await readSelectedPositionState(wallet, body.selection, connection, true);
    } catch (error) {
      if (error instanceof Error && error.message === "Wallet does not currently hold this Raydium CLMM position NFT") {
        return Response.json({ state: null, signature: body.signature, status: "manual-review" },
          { headers: { "Cache-Control": "no-store" } });
      }
      throw error;
    }
    if (state.poolId !== body.poolId || state.positionAccount !== body.positionAccount) {
      throw new Error("Position to be verified has changed");
    }
    const base = { state, signature: body.signature };
    if (!observed) {
      const height = await connection.getBlockHeight("confirmed");
      const unchanged = state.ownsNft && state.liquidity === body.startingLiquidity &&
        state.balances.input === body.startingBalances.input &&
        state.balances.a === body.startingBalances.a && state.balances.b === body.startingBalances.b;
      return Response.json({ ...base, status: height <= body.lastValidBlockHeight ? "pending" : unchanged ? "expired" : "manual-review" },
        { headers: { "Cache-Control": "no-store" } });
    }
    if (observed.err) return Response.json({ ...base, status: "failed", transactionError: observed.err },
      { headers: { "Cache-Control": "no-store" } });
    if (observed.confirmationStatus !== "confirmed" && observed.confirmationStatus !== "finalized") {
      return Response.json({ ...base, status: "pending" }, { headers: { "Cache-Control": "no-store" } });
    }
    const transaction = await connection.getParsedTransaction(body.signature,
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!transaction) return Response.json({ ...base, status: "pending" }, { headers: { "Cache-Control": "no-store" } });
    if (transaction.meta?.err) return Response.json({ ...base, status: "failed", transactionError: transaction.meta.err },
      { headers: { "Cache-Control": "no-store" } });
    const signedByWallet = transaction.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === wallet && key.signer);
    const discriminator = createHash("sha256").update("global:increase_liquidity_v2").digest().subarray(0, 8);
    const add = transaction.transaction.message.instructions.find((ix) =>
      ix.programId.toBase58() === state.programId && "accounts" in ix &&
      ix.accounts[0]?.toBase58() === wallet && ix.accounts[2]?.toBase58() === state.poolId &&
      ix.accounts[4]?.toBase58() === state.positionAccount &&
      Buffer.from(bs58.decode(ix.data)).subarray(0, 8).equals(discriminator));
    const transactionLiquidity = add && "data" in add ? instructionLiquidity(bs58.decode(add.data)) : null;
    const success = confirmedAtomicSuccess({ signedByWallet, addedToExactPosition: Boolean(add), ownsNft: state.ownsNft,
      startingLiquidity: body.startingLiquidity, expectedLiquidity: body.expectedLiquidity,
      currentLiquidity: state.liquidity, transactionLiquidity });
    return Response.json({ ...base, status: success ? "success" : "manual-review",
      signedByWallet, addedToExactPosition: Boolean(add) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Transaction verification failed");
  }
}
