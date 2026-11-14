import BN from "bn.js";
import {
  ClmmInstrument,
  getPdaExBitmapAccount,
  getPdaProtocolPositionAddress,
  getPdaTickArrayAddress,
  PoolUtil,
  TickArrayUtil,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";

export type RaydiumAddLiquidityAccounts = {
  programId: string;
  poolId: string;
  nftAta: string;
  positionAccount: string;
  ataA: string;
  ataB: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
};

export type RaydiumAddLiquidityAmounts = {
  liquidity: string;
  amountMaxA: string;
  amountMaxB: string;
};

/**
 * Raydium `increaseLiquidityV2` from already verified accounts.
 * Same instruction as the previous app builder: no extra account fetch, no fee instruction.
 */
export function buildRaydiumIncreaseLiquidityInstruction(
  state: RaydiumAddLiquidityAccounts,
  amounts: RaydiumAddLiquidityAmounts,
  wallet: PublicKey,
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
    new BN(amounts.liquidity), new BN(amounts.amountMaxA), new BN(amounts.amountMaxB), null, bitmap,
  );
}
