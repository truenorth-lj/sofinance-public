import type { SelectedPositionState } from "./selected-state";

export type CompoundReward = {
  index: number; mint: string; vault: string; program: string; decimals: number;
  account: string; estimatedAmount: string; compounded: boolean;
};
export type CompoundPositionState = SelectedPositionState & {
  eligible: boolean; reason: string | null; status: number;
  vaultA: string; vaultB: string; tickSpacing: number;
  fees: { a: string; b: string }; rewards: CompoundReward[];
};
export type CompoundAccount = {
  seed: string; address: string; mint: string; program: string;
  space: number; rentLamports: number;
};
export type CompoundSwap = {
  inputMint: string; outputMint: string; inputAmount: string;
  quotedOutputAmount: string; minOutputAmount: string; simulatedOutputAmount?: string;
  inputDecimals: number; outputDecimals: number; poolId: string; sqrtPriceAfterX64: string;
};
export type CompoundPriorSource = {
  sourceSignature: string; address: string; mint: string; program: string;
  amount: string; destination: string; refundLamports: number;
};
export type CompoundSummary = {
  operation: "compound"; simulated: true; state: CompoundPositionState;
  positionMint: string; positionAccount: string; poolId: string;
  startingLiquidity: string; liquidity: string; amountMaxA: string; amountMaxB: string;
  compoundAccounts: [CompoundAccount, CompoundAccount];
  swaps?: CompoundSwap[]; priorSources?: CompoundPriorSource[];
  simulatedHarvest: { a: string; b: string };
  simulatedRewards: { mint: string; amount: string; compounded: boolean }[];
  simulatedEndingLiquidity: string; simulatedDustA: string; simulatedDustB: string;
  simulatedSolDebitLamports: string; maxSolDebitLamports: string;
  feeLamports: number; rentLamports: number; sizeBytes: number; unitsConsumed?: number;
  blockhash: string; lastValidBlockHeight: number; simulatedAt: number; expiresAt: number;
  beam?: {
    included: boolean;
    tipLamports: number;
    tipAddress: string | null;
    skippedReason: "disabled" | "no-tip-address" | "oversize" | null;
  };
};
