import { createHash } from "node:crypto";
import { getPdaExBitmapAccount, getPdaObservationAccount, MEMO_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { MAX_U64, sizeCompoundLiquidity } from "./compound-math";
import type { CompoundAccount, CompoundPositionState } from "./compound-types";

export type CompoundSwap = {
  inputMint: string; outputMint: string; inputAmount: string;
  quotedOutputAmount: string; minOutputAmount: string;
  inputDecimals: number; outputDecimals: number; poolId: string; sqrtPriceAfterX64: string;
  feeBps: number; feeAmount: string;
  poolFeeAmount?: string;
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

export { buildCompoundSwapPlan } from "./swap/compound";
