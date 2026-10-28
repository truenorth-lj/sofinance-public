import "@/lib/engine-host";
import "server-only";
import { invalidatePositionHistoryCache } from "./position-history-cache";

import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { readCompoundPositionState } from "@sofinance/engine/compound-state";
import { simulateAndVerifyCompound } from "@sofinance/engine/compound-simulation";
import { CompoundSendError } from "./public-error";
import { rpcConnection } from "@sofinance/engine/rpc";
import { beamAfterSend, noBeamAfterSend } from "@/lib/beam-after-send";
import type { CompoundSummary } from "@sofinance/engine/compound-types";

export { CompoundSendError };

export async function reverifySignedCompound(
  wallet: string, transaction: VersionedTransaction, summary: CompoundSummary,
  prepared?: VersionedTransaction,
) {
  const connection = rpcConnection();
  const [height, state] = await Promise.all([
    connection.getBlockHeight("confirmed"), readCompoundPositionState(wallet, summary.positionMint, connection),
  ]);
  if (height > summary.lastValidBlockHeight) throw new Error("Compound blockhash expired");
  if (!state.eligible || state.positionAccount !== summary.positionAccount || state.poolId !== summary.poolId ||
    state.tickLower !== summary.state.tickLower || state.tickUpper !== summary.state.tickUpper ||
    state.liquidity !== summary.startingLiquidity || state.mintA !== summary.state.mintA || state.mintB !== summary.state.mintB ||
    state.programA !== summary.state.programA || state.programB !== summary.state.programB ||
    state.nftAta !== summary.state.nftAta || state.rangeSide !== summary.state.rangeSide) {
    throw new Error("Compound position identity, liquidity, or availability status has changed");
  }
  const verified = await simulateAndVerifyCompound({ connection, transaction, state,
    compoundAccounts: summary.compoundAccounts, priorSources: summary.priorSources, expectedLiquidity: BigInt(summary.liquidity),
    maxSolDebitLamports: BigInt(summary.maxSolDebitLamports), sigVerify: true, prepared });
  if (verified.rewards.some((reward) => BigInt(reward.amount) > 0n)) {
    throw new Error("Third reward yield appeared with no isolated swap path, cannot fully reinvest; transaction not sent");
  }
  if (Date.now() >= summary.expiresAt || await connection.getBlockHeight("confirmed") > summary.lastValidBlockHeight) {
    throw new Error("Compound transaction expired before broadcast");
  }
  if (!transaction.message.staticAccountKeys[0]?.equals(new PublicKey(wallet))) throw new Error("Compound payer mismatch");
  return connection;
}

export async function sendSignedCompoundTransaction(
  wallet: string, transaction: VersionedTransaction, summary: CompoundSummary,
  prepared?: VersionedTransaction,
) {
  let connection;
  try {
    connection = await reverifySignedCompound(wallet, transaction, summary, prepared);
  } catch (error) {
    throw new CompoundSendError(error, false);
  }
  try {
    const expected = bs58.encode(transaction.signatures[0]!);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    if (signature !== expected) throw new Error("RPC returned compound signature mismatch, please verify on-chain status");
    invalidatePositionHistoryCache(summary.positionMint);
    const beam = await beamAfterSend(signature, summary.beam).catch(() => noBeamAfterSend(signature));
    return { signature, beam: beam.beam, beamLabel: beam.label, beamLandingUrl: beam.beamLandingUrl };
  } catch (error) {
    // The retrying RPC exposes only its last error. Even a preflight rejection
    // may follow an accepted send whose response was lost; keep the original
    // signature pending until reconciliation establishes its outcome.
    throw new CompoundSendError(error);
  }
}
