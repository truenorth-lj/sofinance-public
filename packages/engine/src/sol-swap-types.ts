import type { NATIVE_SOL_MINT } from "./ids";

export type SolSwapStepSummary = {
  operation: "sol-swap-step";
  wallet: string;
  poolId: string;
  inputMint: typeof NATIVE_SOL_MINT;
  /** Pool token the swap delivers; step 2/2 opens with it as a token input. */
  outputMint: string;
  outputDecimals: number;
  outputSymbol: string | null;
  outputAccount: string;
  /** Gross lamports wrapped and swapped (fee included, charged by Jupiter). */
  requested: string;
  feeBps: number;
  feeAmount: string;
  feeWallet: string | null;
  quotedOut: string;
  minOut: string;
  /** Output-account increase in the server-side simulation. */
  simulatedOut: string;
  simulatedSolDebitLamports: string;
  feeLamports: number;
  sizeBytes: number;
  unitsConsumed: number;
  blockhash: string;
  lastValidBlockHeight: number;
  simulatedAt: number;
  expiresAt: number;
};


export type SolSwapDelivery =
  | { status: "pending" | "expired" | "failed" }
  | {
    status: "confirmed"; delivered: string; decimals: number; blockTime: number | null;
    slot: number;
  };
