import "server-only";

import BN from "bn.js";
import { ClmmInstrument, getPdaExBitmapAccount, getPdaProtocolPositionAddress, getPdaTickArrayAddress, PoolUtil, TickArrayUtil } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import type { SelectedQuote } from "./selected-quote";
import type { SelectedPositionState } from "./selected-state";

type AddState = Pick<SelectedPositionState, "programId" | "poolId" | "nftAta" | "positionAccount" |
  "ataA" | "ataB" | "mintA" | "mintB" | "tickLower" | "tickUpper"> & {
  tickSpacing: number; vaultA: string; vaultB: string;
};

/** Same SDK instruction, using the already verified chain accounts without fetching swap tick arrays. */
export function buildSelectedAddInstruction(
  state: AddState, quote: Pick<SelectedQuote, "liquidity" | "amountMaxA" | "amountMaxB">, wallet: PublicKey,
) {
  const program = new PublicKey(state.programId);
  const pool = new PublicKey(state.poolId);
  const starts = [state.tickLower, state.tickUpper].map((tick) => TickArrayUtil.getTickArrayStartIndex(tick, state.tickSpacing));
  const ticks = starts.map((start) => getPdaTickArrayAddress(program, pool, start).publicKey);
  const protocol = getPdaProtocolPositionAddress(program, pool, state.tickLower, state.tickUpper).publicKey;
  const bitmap = PoolUtil.isOverflowDefaultTickarrayBitmap({ tickSpacing: state.tickSpacing, tickIndexs: starts })
    ? getPdaExBitmapAccount(program, pool).publicKey : undefined;
  return ClmmInstrument.increaseLiquidityV2Instruction(
    program, wallet, new PublicKey(state.nftAta), new PublicKey(state.positionAccount), pool, protocol,
    ticks[0]!, ticks[1]!, new PublicKey(state.ataA), new PublicKey(state.ataB),
    new PublicKey(state.vaultA), new PublicKey(state.vaultB), new PublicKey(state.mintA), new PublicKey(state.mintB),
    new BN(quote.liquidity), new BN(quote.amountMaxA), new BN(quote.amountMaxB), null, bitmap,
  );
}
