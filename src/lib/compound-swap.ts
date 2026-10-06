import "server-only";

import { createHash } from "node:crypto";
import BN from "bn.js";
import { ClmmConfigLayout, ClmmInstrument, getPdaExBitmapAccount, getPdaObservationAccount, getPdaTickArrayAddress, MEMO_PROGRAM_ID, PoolUtils, swapInternal, TickArrayLayout, TickArrayUtil, type ClmmKeys, type ComputeClmmPoolInfo, type ReturnTypeFetchMultiplePoolTickArrays, type SimpleClmmPoolInfo } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { MAX_U64, sizeCompoundLiquidity } from "./compound-math";
import { SLIPPAGE_BPS } from "./ids";
import type { CompoundAccount, CompoundPositionState } from "./compound-types";

export type CompoundSwap = {
  inputMint: string; outputMint: string; inputAmount: string;
  quotedOutputAmount: string; minOutputAmount: string;
  inputDecimals: number; outputDecimals: number; poolId: string; sqrtPriceAfterX64: string;
};
export type CompoundSwapQuote = { output: bigint; sqrtPriceX64: bigint };
type Direction = "a-to-b" | "b-to-a";
type SwapContext = {
  price: bigint; lower: bigint; upper: bigint; amountA: bigint; amountB: bigint;
  startingLiquidity?: bigint; quote: (direction: Direction, input: bigint) => CompoundSwapQuote;
};
function ratioDifference(price: bigint, lower: bigint, upper: bigint, a: bigint, b: bigint) {
  const p = price < lower ? lower : price > upper ? upper : price;
  return a * (p - lower) * upper * p - b * (1n << 128n) * (upper - p);
}

/** Find the crossing of available and required token ratios at the price AFTER
 * swapping. This also handles a swap that moves an outside position in range.
 * Only the isolated harvested balances are available to this search. */
export function optimizeCompoundSwap(input: SwapContext) {
  const { price, lower, upper, amountA, amountB, startingLiquidity = 0n, quote } = input;
  const baseline = sizeCompoundLiquidity(price, lower, upper, amountA, amountB, startingLiquidity);
  const initialDifference = ratioDifference(price, lower, upper, amountA, amountB);
  const empty = { direction: null, input: 0n, output: 0n, sqrtPriceX64: price,
    balances: { a: amountA, b: amountB }, sized: baseline };
  if (initialDifference === 0n) return empty;
  const direction: Direction = initialDifference > 0n ? "a-to-b" : "b-to-a";
  const budget = direction === "a-to-b" ? amountA : amountB;
  const cache = new Map<bigint, ReturnType<typeof evaluate>>();
  function evaluate(amount: bigint) {
    const q = amount === 0n ? { output: 0n, sqrtPriceX64: price } : quote(direction, amount);
    if (q.output < 0n || q.output > MAX_U64 || q.sqrtPriceX64 <= 0n) throw new Error("Invalid yield swap quote");
    const a = direction === "a-to-b" ? amountA - amount : amountA + q.output;
    const b = direction === "a-to-b" ? amountB + q.output : amountB - amount;
    const difference = ratioDifference(q.sqrtPriceX64, lower, upper, a, b);
    return { direction, input: amount, output: q.output, sqrtPriceX64: q.sqrtPriceX64,
      balances: { a, b }, difference,
      sized: sizeCompoundLiquidity(q.sqrtPriceX64, lower, upper, a, b, startingLiquidity) };
  }
  const get = (amount: bigint) => {
    let result = cache.get(amount);
    if (!result) { result = evaluate(amount); cache.set(amount, result); }
    return result;
  };
  let low = 0n, high = budget;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const result = get(mid);
    const stillExcess = direction === "a-to-b" ? result.difference >= 0n : result.difference <= 0n;
    if (stillExcess) low = mid;
    else high = mid - 1n;
  }
  // Integer rounding can put the optimum on either side of the crossing.
  const candidates = [...new Set([low, ...(low < budget ? [low + 1n] : []), 0n])].map(get);
  const best = candidates.reduce((chosen, candidate) => candidate.sized.liquidity > chosen.sized.liquidity ||
    candidate.sized.liquidity === chosen.sized.liquidity && candidate.input < chosen.input ? candidate : chosen);
  if (best.input === 0n) {
    // A positive balance on the unusable side must not silently become a
    // reported successful full compound when no protected swap can use it.
    if (baseline.liquidity === 0n && budget > 0n) throw new Error("After yield swap still cannot form reinvestable liquidity");
    return empty;
  }
  if (best.output === 0n) throw new Error("Yield swap below minimum output unit, cannot protect full reinvestment");
  return best;
}

export type CompoundSwapShape = {
  state: CompoundPositionState; accounts: [CompoundAccount, CompoundAccount];
  swap: CompoundSwap; config: string; observation: string; tickArrays: string[];
};

/** Validate every account and privilege independently of the SDK's builder.
 * The caller supplies tick arrays whose ownership/pool/PDA were read on chain. */
export function validateCompoundSwapInstruction(ix: TransactionInstruction, shape: CompoundSwapShape) {
  const { state, accounts, swap, config, observation, tickArrays } = shape;
  const inputA = swap.inputMint === state.mintA;
  const inputIndex = inputA ? 0 : 1, outputIndex = inputA ? 1 : 0;
  const inputAmount = BigInt(swap.inputAmount), minOutput = BigInt(swap.minOutputAmount), quotedOutput = BigInt(swap.quotedOutputAmount);
  const expected = [state.wallet, config, state.poolId, accounts[inputIndex].address, accounts[outputIndex].address,
    inputA ? state.vaultA : state.vaultB, inputA ? state.vaultB : state.vaultA, observation,
    TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), MEMO_PROGRAM_ID.toBase58(),
    swap.inputMint, swap.outputMint,
    getPdaExBitmapAccount(new PublicKey(state.programId), new PublicKey(state.poolId)).publicKey.toBase58(), ...tickArrays];
  if (swap.poolId !== state.poolId || ![state.mintA, state.mintB].includes(swap.inputMint) ||
    swap.outputMint !== (inputA ? state.mintB : state.mintA) || inputAmount <= 0n || inputAmount > MAX_U64 ||
    minOutput <= 0n || minOutput > quotedOutput || quotedOutput > MAX_U64 ||
    accounts[0].mint !== state.mintA || accounts[1].mint !== state.mintB ||
    accounts.some((account) => [state.ataA, state.ataB].includes(account.address)) ||
    accounts[0].address === accounts[1].address || tickArrays.length === 0 || new Set(tickArrays).size !== tickArrays.length ||
    observation !== getPdaObservationAccount(new PublicKey(state.programId), new PublicKey(state.poolId)).publicKey.toBase58() ||
    ix.programId.toBase58() !== state.programId || ix.data.length !== 41 ||
    !ix.data.subarray(0, 8).equals(createHash("sha256").update("global:swap_v2").digest().subarray(0, 8)) ||
    ix.data.readBigUInt64LE(8) !== inputAmount || ix.data.readBigUInt64LE(16) !== minOutput ||
    ix.data.subarray(24, 40).some((byte) => byte !== 0) || ix.data[40] !== 1 || ix.keys.length !== expected.length) throw new Error("Compound swap instruction, mint, or limit mismatch");
  const writable = new Set([2, 3, 4, 5, 6, 7, ...expected.slice(13).map((_, index) => index + 13)]);
  ix.keys.forEach((key, index) => {
    if (key.pubkey.toBase58() !== expected[index] || key.isSigner !== (index === 0) || key.isWritable !== writable.has(index)) throw new Error("Compound swap account or permission mismatch");
  });
}

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
  const blockTimestamp = await connection.getBlockTime(slot);
  if (blockTimestamp === null) throw new Error("Unable to get on-chain time for yield swap");
  // The SDK mutates dynamicFeeInfo while quoting. Every candidate must start
  // from the same chain snapshot, including the final minimal-account quote.
  const poolSnapshot = () => ({ ...computePoolInfo.accInfo, dynamicFeeInfo: { ...computePoolInfo.accInfo.dynamicFeeInfo,
    lastUpdateTimestamp: computePoolInfo.accInfo.dynamicFeeInfo.lastUpdateTimestamp.clone() } });
  const quoteCache = new Map<string, ReturnType<typeof PoolUtils.computeAmountOut>>();
  const quote = (direction: Direction, amount: bigint): CompoundSwapQuote => {
    const key = `${direction}:${amount}`;
    const result = PoolUtils.computeAmountOut({ poolInfo: { ...computePoolInfo, accInfo: poolSnapshot() }, tickarrayBitmapExtension: computePoolInfo.exBitmapInfo,
      tickArrayCache: tickData[state.poolId] ?? {}, baseMint: new PublicKey(direction === "a-to-b" ? state.mintA : state.mintB),
      epochInfo, amountIn: new BN(amount.toString()), slippage: 0, catchLiquidityInsufficient: false, blockTimestamp });
    if (!result.allTrade || result.realAmountIn.fee?.gt(new BN(0)) || result.amountOut.fee?.gt(new BN(0))) throw new Error("Yield swap cannot fully execute or contains unsupported transfer fee");
    quoteCache.set(key, result);
    return { output: BigInt(result.amountOut.amount.toString()), sqrtPriceX64: BigInt(result.executionPriceX64.toString()) };
  };
  const planned = optimizeCompoundSwap({ price: BigInt(computePoolInfo.sqrtPriceX64.toString()), lower: BigInt(state.lowerSqrtX64),
    upper: BigInt(state.upperSqrtX64), amountA, amountB, startingLiquidity: BigInt(state.liquidity), quote });
  if (!planned.direction) return { instruction: null, swap: null, quotedBalances: planned.balances, sqrtPriceAfterX64: planned.sqrtPriceX64 };
  if (state.status & 16) throw new Error("Pool has disabled yield swapping");
  const result = quoteCache.get(`${planned.direction}:${planned.input}`)!;
  const slippageMinimum = planned.output * BigInt(10_000 - SLIPPAGE_BPS) / 10_000n;
  // One raw output unit still has a usable strict minimum of one; zero must
  // never be accepted merely because flooring the bps allowance produced it.
  const minOutput = slippageMinimum > 0n ? slippageMinimum : 1n;
  const inputA = planned.direction === "a-to-b";
  const swap: CompoundSwap = { inputMint: inputA ? state.mintA : state.mintB, outputMint: inputA ? state.mintB : state.mintA,
    inputAmount: planned.input.toString(), quotedOutputAmount: planned.output.toString(), minOutputAmount: minOutput.toString(),
    inputDecimals: inputA ? state.decimalsA : state.decimalsB, outputDecimals: inputA ? state.decimalsB : state.decimalsA,
    poolId: state.poolId, sqrtPriceAfterX64: planned.sqrtPriceX64.toString() };
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
  return { instruction, swap, quotedBalances: planned.balances, sqrtPriceAfterX64: planned.sqrtPriceX64 };
}
