import type { BeamTipPlan } from "../solami-beam";
export type WithdrawRequest = {
    wallet: string;
    positionMint: string;
    percent?: number;
    targetUSDC?: number;
    receive?: "usdc" | "token" | "original";
    outputMint?: string;
    confirmHighImpact?: boolean;
};
export type WithdrawAsset = {
    mint: string;
    account: string;
    program: string;
    decimals: number;
    starting: string;
    amount: string;
    minimum?: string;
    source?: string;
};
export type WithdrawSummary = {
    operation: "withdraw";
    wallet: string;
    positionMint: string;
    positionAccount: string;
    poolId: string;
    percentBps: number;
    receive: "usdc" | "token" | "original";
    outputMint?: string;
    stage: "atomic" | "withdraw" | "swap";
    transactions: 1 | 2;
    closesPosition: boolean;
    isolatedSources?: import("../swap/isolated-account").IsolatedTokenAccount[];
    startingLiquidity: string;
    removedLiquidity: string;
    assets: WithdrawAsset[];
    outputs: {
        mint: string;
        expected: string;
        minimum: string;
        decimals: number;
    }[];
    priceImpactBps: number;
    warning: boolean;
    requiresSecondConfirmation: boolean;
    slippageBps: number;
    protocolFee: {
        bps: number;
        wallet: string | null;
        legs: {
            mint: string;
            amount: string;
            collectedMint?: string;
            collectedAmount?: string;
        }[];
    };
    rentRefundLamports: string;
    maxSolDebitLamports: string;
    expiresAt: number;
    lastValidBlockHeight: number;
    blockhash: string;
    bytes: number;
    beam: BeamTipPlan;
    tx1Signature?: string;
};
export type WithdrawPrepared = {
    summary: WithdrawSummary;
    unsignedTransaction: string;
    permit: string;
};
export type WithdrawPrepareRequest = WithdrawRequest & {
    stage?: "swap";
    tx1Signature?: string;
    previous?: WithdrawPrepared;
};
