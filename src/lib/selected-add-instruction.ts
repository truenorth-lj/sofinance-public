import "@/lib/engine-host";
import "server-only";

import { buildRaydiumIncreaseLiquidityInstruction } from "@sofinance/engine/protocols/raydium/add-liquidity";
import type { SelectedPositionState } from "@sofinance/engine/selected-state";
import { PublicKey } from "@solana/web3.js";
import type { SelectedQuote } from "./selected-quote";

type AddState = Pick<SelectedPositionState, "programId" | "poolId" | "nftAta" | "positionAccount" |
  "ataA" | "ataB" | "mintA" | "mintB" | "tickLower" | "tickUpper"> & {
  tickSpacing: number; vaultA: string; vaultB: string;
};

/** Same SDK instruction, using the already verified chain accounts without fetching swap tick arrays. */
export function buildSelectedAddInstruction(
  state: AddState, quote: Pick<SelectedQuote, "liquidity" | "amountMaxA" | "amountMaxB">, wallet: PublicKey,
) {
  return buildRaydiumIncreaseLiquidityInstruction(state, quote, wallet);
}
