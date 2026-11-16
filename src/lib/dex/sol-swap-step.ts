import type { VersionedTransaction } from "@solana/web3.js";
import type { SolSwapDelivery, SolSwapStepSummary } from "@sofinance/engine/sol-swap-types";
export type SolSwapCommand = { wallet: string; poolId: string; amount: string };
export type SolSwapDeliveryCommand = { wallet: string; signature: string; outputMint: string; lastValidBlockHeight?: number };
export type BuildSolSwapStep = (command: SolSwapCommand) => Promise<{ summary: SolSwapStepSummary; transaction: VersionedTransaction }>;
export type ReadSolSwapDelivery = (command: SolSwapDeliveryCommand) => Promise<SolSwapDelivery>;
