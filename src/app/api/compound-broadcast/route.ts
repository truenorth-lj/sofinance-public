import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { parseCompoundBroadcast } from "@/lib/compound-api";
import { readCompoundPositionState } from "@/lib/compound-state";
import { simulateAndVerifyCompound } from "@/lib/compound-simulation";
import { rpcConnection } from "@/lib/rpc";
import { apiError } from "@/lib/api-response";
import type { CompoundSummary } from "@/lib/compound-types";

export async function POST(request: Request) {
  try {
    const parsed = await parseCompoundBroadcast(request, "compound");
    const summary = parsed.summary as CompoundSummary;
    const connection = rpcConnection();
    const [height, state] = await Promise.all([
      connection.getBlockHeight("confirmed"), readCompoundPositionState(parsed.wallet, summary.positionMint, connection),
    ]);
    if (height > summary.lastValidBlockHeight) throw new Error("Compound blockhash expired");
    if (!state.eligible || state.positionAccount !== summary.positionAccount || state.poolId !== summary.poolId ||
      state.tickLower !== summary.state.tickLower || state.tickUpper !== summary.state.tickUpper ||
      state.liquidity !== summary.startingLiquidity || state.mintA !== summary.state.mintA || state.mintB !== summary.state.mintB ||
      state.programA !== summary.state.programA || state.programB !== summary.state.programB ||
      state.nftAta !== summary.state.nftAta || state.rangeSide !== summary.state.rangeSide) {
      throw new Error("Compound position identity, liquidity, or availability status has changed");
    }
    const verified = await simulateAndVerifyCompound({ connection, transaction: parsed.transaction, state,
      compoundAccounts: summary.compoundAccounts, priorSources: summary.priorSources, expectedLiquidity: BigInt(summary.liquidity),
      maxSolDebitLamports: BigInt(summary.maxSolDebitLamports), sigVerify: true });
    if (verified.rewards.some((reward) => BigInt(reward.amount) > 0n)) {
      throw new Error("Third reward yield appeared with no isolated swap path, cannot fully reinvest; transaction not sent");
    }
    if (Date.now() >= summary.expiresAt || await connection.getBlockHeight("confirmed") > summary.lastValidBlockHeight) {
      throw new Error("Compound transaction expired before broadcast");
    }
    if (!parsed.transaction.message.staticAccountKeys[0]?.equals(new PublicKey(parsed.wallet))) throw new Error("Compound payer mismatch");
    const expected = bs58.encode(parsed.transaction.signatures[0]!);
    const signature = await connection.sendRawTransaction(parsed.transaction.serialize(), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    if (signature !== expected) throw new Error("RPC returned compound signature mismatch, please verify on-chain status");
    return Response.json({ signature }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Compound transaction broadcast failed"); }
}
