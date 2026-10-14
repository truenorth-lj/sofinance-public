import { createHash } from "node:crypto";
import { PublicKey, type Connection } from "@solana/web3.js";
import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import bs58 from "bs58";
import { parseWallet } from "@/lib/api-input";
import { confirmedAtomicSuccess, instructionLiquidity } from "@/lib/attempt-status";
import { apiError } from "@/lib/api-response";
import { readSelectedPositionState, type PositionSelection } from "@/lib/selected-state";
import { rpcConnection } from "@/lib/rpc";
import { invalidatePositionHistoryCache } from "@/lib/position-history-cache";
import { resetRpcCache } from "@/lib/rpc/cache";

/** Blocks past lastValidBlockHeight after which an unseen signature is treated as expired regardless of wallet changes. */
const EXPIRY_GRACE_BLOCKS = 150;

async function blockhashDefinitelyExpired(connection: Connection, lastValidBlockHeight: number) {
  return await connection.getBlockHeight("confirmed") > lastValidBlockHeight + EXPIRY_GRACE_BLOCKS;
}

async function verifyAddTransaction(connection: Connection, body: { signature: string; poolId: string; positionAccount: string; expectedLiquidity: string },
  wallet: string, programId: string) {
  const transaction = await connection.getParsedTransaction(body.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!transaction) return null;
  if (transaction.meta?.err) return { failed: transaction.meta.err, success: false, signedByWallet: false, added: false, transactionLiquidity: null };
  const signedByWallet = transaction.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === wallet && key.signer);
  const discriminator = createHash("sha256").update("global:increase_liquidity_v2").digest().subarray(0, 8);
  const add = transaction.transaction.message.instructions.find((ix) =>
    ix.programId.toBase58() === programId && "accounts" in ix &&
    ix.accounts[0]?.toBase58() === wallet && ix.accounts[2]?.toBase58() === body.poolId &&
    ix.accounts[4]?.toBase58() === body.positionAccount &&
    Buffer.from(bs58.decode(ix.data)).subarray(0, 8).equals(discriminator));
  const transactionLiquidity = add && "data" in add ? instructionLiquidity(bs58.decode(add.data)) : null;
  const success = signedByWallet && Boolean(add) && BigInt(body.expectedLiquidity) > 0n && transactionLiquidity === BigInt(body.expectedLiquidity);
  return { failed: null, success, signedByWallet, added: Boolean(add), transactionLiquidity };
}

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
    const reply = (payload: Record<string, unknown>) => Response.json(payload, { headers: { "Cache-Control": "no-store" } });
    let state;
    try {
      state = await readSelectedPositionState(wallet, body.selection, connection, true);
    } catch (error) {
      if (error instanceof Error && error.message === "Wallet does not currently hold this Raydium CLMM position NFT") {
        // The position may have been withdrawn or moved after this attempt. Resolve from the
        // signature alone so the warning cannot stay stuck on a terminal transaction.
        const base = { state: null, signature: body.signature };
        if (observed?.err) return reply({ ...base, status: "failed", transactionError: observed.err });
        if (!observed) return reply({ ...base, status: await blockhashDefinitelyExpired(connection, body.lastValidBlockHeight) ? "expired" : "manual-review" });
        if (observed.confirmationStatus === "finalized") {
          const verified = await verifyAddTransaction(connection, body, wallet, CLMM_PROGRAM_ID.toBase58());
          if (verified?.failed) return reply({ ...base, status: "failed", transactionError: verified.failed });
          if (verified?.success) return reply({ ...base, status: "success", signedByWallet: true, addedToExactPosition: true });
        }
        return reply({ ...base, status: "manual-review" });
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
      // A signature that is still unknown well past its blockhash expiry can never land, even if the
      // wallet changed since (later adds, withdrawals); otherwise the warning would never clear.
      return reply({ ...base, status: height <= body.lastValidBlockHeight ? "pending"
        : unchanged || height > body.lastValidBlockHeight + EXPIRY_GRACE_BLOCKS ? "expired" : "manual-review" });
    }
    if (observed.err) return reply({ ...base, status: "failed", transactionError: observed.err });
    if (observed.confirmationStatus !== "confirmed" && observed.confirmationStatus !== "finalized") {
      return reply({ ...base, status: "pending" });
    }
    const verified = await verifyAddTransaction(connection, body, wallet, state.programId);
    if (!verified) return reply({ ...base, status: "pending" });
    if (verified.failed) return reply({ ...base, status: "failed", transactionError: verified.failed });
    // Once finalized, the transaction itself proves the add; later position changes (for example a
    // withdrawal) must not turn a landed add back into manual review.
    const success = confirmedAtomicSuccess({ signedByWallet: verified.signedByWallet, addedToExactPosition: verified.added, ownsNft: state.ownsNft,
      startingLiquidity: body.startingLiquidity, expectedLiquidity: body.expectedLiquidity,
      currentLiquidity: state.liquidity, transactionLiquidity: verified.transactionLiquidity }) ||
      (observed.confirmationStatus === "finalized" && verified.success);
    if (success) {
      invalidatePositionHistoryCache(body.selection.positionMint);
      resetRpcCache();
    }
    return reply({ ...base, status: success ? "success" : "manual-review",
      signedByWallet: verified.signedByWallet, addedToExactPosition: verified.added });
  } catch (error) {
    return apiError(error, "Transaction verification failed");
  }
}
