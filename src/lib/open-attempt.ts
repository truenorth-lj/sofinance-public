import "@/lib/engine-host";
import type { OpenPositionSummary } from "@sofinance/engine/open-types";

export type OpenAttempt = {
  version: 1; wallet: string; signature: string; nftMint: string; positionAccount: string;
  poolId: string; tickLower: number; tickUpper: number; liquidity: string;
  blockhash: string; lastValidBlockHeight: number; createdAt: number;
};
export type OpenAttemptStatus = "pending" | "confirmed" | "failed" | "expired" | "manual-review" | "unsent";

export function openAttemptFromSummary(signature: string, summary: OpenPositionSummary): OpenAttempt {
  return { version: 1, wallet: summary.wallet, signature, nftMint: summary.nftMint, positionAccount: summary.positionAccount,
    poolId: summary.poolId, tickLower: summary.tickLower, tickUpper: summary.tickUpper, liquidity: summary.quote.liquidity,
    blockhash: summary.blockhash, lastValidBlockHeight: summary.lastValidBlockHeight, createdAt: Date.now() };
}
