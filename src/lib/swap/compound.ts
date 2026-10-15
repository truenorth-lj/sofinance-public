import "server-only";
import BN from "bn.js";
import { ClmmConfigLayout, ClmmInstrument, getPdaTickArrayAddress, PoolUtils, swapInternal, TickArrayLayout, TickArrayUtil, type ClmmKeys, type ComputeClmmPoolInfo, type ReturnTypeFetchMultiplePoolTickArrays, type SimpleClmmPoolInfo } from "@raydium-io/raydium-sdk-v2";
import { Connection, PublicKey } from "@solana/web3.js";
import { readRecentBlockTime } from "../block-time";
import { SLIPPAGE_BPS } from "../ids";
import { optimizeCompoundSwap, validateCompoundSwapInstruction, type CompoundSwap, type CompoundSwapQuote } from "../compound-swap";
import type { CompoundAccount, CompoundPositionState } from "../compound-types";
import { netSwapInput, readSwapFeeConfig } from "./fee";

type Direction = "a-to-b" | "b-to-a";

/** Native Raydium `swap_v2` through the position's own pool, signed by the
 * wallet against the isolated yield accounts. Unlike a Jupiter `route`, it adds
 * no program id and reuses the harvest/add pool, vault, mint and token-program
 * keys, so harvest + swap + add fits one 1,232-byte packet. Every account and
 * privilege is independently checked by validateCompoundSwapInstruction. */
export async function buildCompoundSwapPlan(input: {
  connection: Connection; state: CompoundPositionState; accounts: [CompoundAccount, CompoundAccount];
  poolInfo: SimpleClmmPoolInfo; poolKeys: ClmmKeys; computePoolInfo: ComputeClmmPoolInfo;
  tickData: ReturnTypeFetchMultiplePoolTickArrays; amountA: bigint; amountB: bigint;
}) {
  const { connection, state, accounts, poolInfo, poolKeys, computePoolInfo, tickData, amountA, amountB } = input;
  if (computePoolInfo.id.toBase58() !== state.poolId || computePoolInfo.programId.toBase58() !== state.programId ||
    computePoolInfo.mintA.address !== state.mintA || computePoolInfo.mintB.address !== state.mintB ||
    computePoolInfo.vaultA.toBase58() !== state.vaultA || computePoolInfo.vaultB.toBase58() !== state.vaultB ||
    poolInfo.id !== state.poolId || poolInfo.programId !== state.programId ||
    poolInfo.config.id !== computePoolInfo.ammConfig.id.toBase58() ||
    poolKeys.observationId !== computePoolInfo.observationId.toBase58()) throw new Error("Compound swap pool snapshot mismatch");
  const [epochInfo, slot, configAccount] = await Promise.all([connection.getEpochInfo("confirmed"), connection.getSlot("confirmed"),
    connection.getAccountInfo(computePoolInfo.ammConfig.id, "confirmed")]);
  if (!configAccount || configAccount.owner.toBase58() !== state.programId) throw new Error("Compound swap config program mismatch");
  const configInfo = ClmmConfigLayout.decode(configAccount.data);
  if (configInfo.tradeFeeRate !== computePoolInfo.ammConfig.tradeFeeRate || configInfo.tickSpacing !== state.tickSpacing) throw new Error("Compound swap config has changed");
  const blockTimestamp = await readRecentBlockTime(connection, slot);
  if (blockTimestamp === null) throw new Error("Unable to get on-chain time for yield swap");
  // The SDK mutates dynamicFeeInfo while quoting. Every candidate must start
  // from the same chain snapshot, including the final minimal-account quote.
  const poolSnapshot = () => ({ ...computePoolInfo.accInfo, dynamicFeeInfo: { ...computePoolInfo.accInfo.dynamicFeeInfo,
    lastUpdateTimestamp: computePoolInfo.accInfo.dynamicFeeInfo.lastUpdateTimestamp.clone() } });
  const feeConfig = readSwapFeeConfig();
  const quoteCache = new Map<string, ReturnType<typeof PoolUtils.computeAmountOut>>();
  const quoteRaw = (direction: Direction, amount: bigint): CompoundSwapQuote => {
    const key = `${direction}:${amount}`;
    const result = PoolUtils.computeAmountOut({ poolInfo: { ...computePoolInfo, accInfo: poolSnapshot() }, tickarrayBitmapExtension: computePoolInfo.exBitmapInfo,
      tickArrayCache: tickData[state.poolId] ?? {}, baseMint: new PublicKey(direction === "a-to-b" ? state.mintA : state.mintB),
      epochInfo, amountIn: new BN(amount.toString()), slippage: 0, catchLiquidityInsufficient: false, blockTimestamp });
    if (!result.allTrade || result.realAmountIn.fee?.gt(new BN(0)) || result.amountOut.fee?.gt(new BN(0))) throw new Error("Yield swap cannot fully execute or contains unsupported transfer fee");
    quoteCache.set(key, result);
    return { output: BigInt(result.amountOut.amount.toString()), sqrtPriceX64: BigInt(result.executionPriceX64.toString()) };
  };
  const quote = (direction: Direction, amount: bigint): CompoundSwapQuote => {
    const { swapAmount } = netSwapInput(amount, feeConfig.bps);
    return swapAmount === 0n
      ? { output: 0n, sqrtPriceX64: BigInt(computePoolInfo.sqrtPriceX64.toString()) }
      : quoteRaw(direction, swapAmount);
  };
  const planned = optimizeCompoundSwap({ price: BigInt(computePoolInfo.sqrtPriceX64.toString()), lower: BigInt(state.lowerSqrtX64),
    upper: BigInt(state.upperSqrtX64), amountA, amountB, startingLiquidity: BigInt(state.liquidity), quote });
  if (!planned.direction) return { instructions: [], route: null, swap: null, quotedBalances: planned.balances, sqrtPriceAfterX64: planned.sqrtPriceX64 };
  if (state.status & 16) throw new Error("Pool has disabled yield swapping");
  const { feeAmount, swapAmount } = netSwapInput(planned.input, feeConfig.bps);
  const result = quoteCache.get(`${planned.direction}:${swapAmount}`)!;
  const slippageMinimum = planned.output * BigInt(10_000 - SLIPPAGE_BPS) / 10_000n;
  // One raw output unit still has a usable strict minimum of one; zero must
  // never be accepted merely because flooring the bps allowance produced it.
  const minOutput = slippageMinimum > 0n ? slippageMinimum : 1n;
  const inputA = planned.direction === "a-to-b";
  const swap: CompoundSwap = { inputMint: inputA ? state.mintA : state.mintB, outputMint: inputA ? state.mintB : state.mintA,
    inputAmount: swapAmount.toString(), quotedOutputAmount: planned.output.toString(), minOutputAmount: minOutput.toString(),
    inputDecimals: inputA ? state.decimalsA : state.decimalsB, outputDecimals: inputA ? state.decimalsB : state.decimalsA,
    poolId: state.poolId, sqrtPriceAfterX64: planned.sqrtPriceX64.toString(),
    feeBps: feeConfig.bps, feeAmount: feeAmount.toString(), poolFeeAmount: result.fee.toString() };
  const currentStart = TickArrayUtil.getTickArrayStartIndex(computePoolInfo.tickCurrent, state.tickSpacing);
  const traversed = swapInternal({ programId: new PublicKey(state.programId), poolId: new PublicKey(state.poolId), poolInfo: poolSnapshot(),
    tickArrays: Object.values(tickData[state.poolId] ?? {}).filter((array) => inputA ? array.startTickIndex <= currentStart : array.startTickIndex >= currentStart)
      .sort((a, b) => inputA ? b.startTickIndex - a.startTickIndex : a.startTickIndex - b.startTickIndex)
      .map((array) => ({ address: array.address, value: array })),
    configInfo,
    tickarrayBitmapExtension: computePoolInfo.exBitmapInfo, amountSpecified: new BN(swap.inputAmount), sqrtPriceLimitX64: new BN(0),
    zeroForOne: inputA, isBaseInput: true, blockTimestamp, includeExtraTickArrays: false });
  if (!traversed.allTrade || traversed.amountCalculated.toString() !== result.amountOut.amount.toString() ||
    traversed.sqrtPriceX64.toString() !== swap.sqrtPriceAfterX64) throw new Error("Compound swap minimal tick accounts quote mismatch");
  const arrays = [...new Map(traversed.accounts.map((address) => [address.toBase58(), address])).values()];
  const infos = await connection.getMultipleAccountsInfo(arrays, "confirmed");
  infos.forEach((info, index) => {
    if (!info || info.owner.toBase58() !== state.programId) throw new Error("Compound swap tick array program mismatch");
    const decoded = TickArrayLayout.decode(info.data);
    if (decoded.poolId.toBase58() !== state.poolId || decoded.startTickIndex % (state.tickSpacing * 60) !== 0 ||
      !arrays[index]!.equals(getPdaTickArrayAddress(new PublicKey(state.programId), new PublicKey(state.poolId), decoded.startTickIndex).publicKey)) throw new Error("Compound swap tick array pool or PDA mismatch");
  });
  const built = ClmmInstrument.makeSwapBaseInInstructions({ poolInfo, poolKeys, observationId: computePoolInfo.observationId,
    ownerInfo: { wallet: new PublicKey(state.wallet), tokenAccountA: new PublicKey(accounts[0].address), tokenAccountB: new PublicKey(accounts[1].address) },
    inputMint: new PublicKey(swap.inputMint), amountIn: new BN(swap.inputAmount), amountOutMin: new BN(swap.minOutputAmount),
    sqrtPriceLimitX64: new BN(0), remainingAccounts: arrays });
  if (built.instructions.length !== 1 || built.signers.length) throw new Error("Compound swap cannot add other signatures or instructions");
  const instruction = built.instructions[0]!;
  validateCompoundSwapInstruction(instruction, { state, accounts, swap, config: computePoolInfo.ammConfig.id.toBase58(),
    observation: computePoolInfo.observationId.toBase58(), tickArrays: arrays.map((address) => address.toBase58()) });
  return { instructions: [instruction], route: null, swap, quotedBalances: planned.balances, sqrtPriceAfterX64: planned.sqrtPriceX64 };
}
