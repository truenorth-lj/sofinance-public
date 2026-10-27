import type { CompoundAccount } from "./compound-types";

export type CompoundRecoveryAccount = CompoundAccount & {
  amount: string; decimals: number; destination: string; sourceLamports: number;
};

export type CompoundRecoverySummary = {
  operation: "recovery"; simulated: true; wallet: string;
  compoundAccounts: CompoundRecoveryAccount[];
  feeLamports: number; sizeBytes: number; unitsConsumed?: number;
  blockhash: string; lastValidBlockHeight: number; expiresAt: number;
};
