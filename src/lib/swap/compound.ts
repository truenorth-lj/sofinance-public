import "server-only";
import BN from "bn.js";
import { SqrtPriceMath, type ClmmKeys, type ComputeClmmPoolInfo, type ReturnTypeFetchMultiplePoolTickArrays, type SimpleClmmPoolInfo } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { sizeCompoundLiquidity } from "../compound-math";
import type { CompoundSwap } from "../compound-swap";
import type { CompoundAccount, CompoundPositionState } from "../compound-types";
import { JupiterHttpError } from "../jupiter";
import { buildRoute, quoteRoute } from "./jupiter";
import { assertOwnPoolRoute, ownPoolConstraints } from "./own-pool";
import { netSwapInput, resolveSwapFeeConfig } from "./fee";
import { rejectUnselectedWalletTokenWrites, swapRouteInstructions } from "./instructions";

/** Only direct routes through the original pool are accepted, so independent
 * receipt/import proof can still identify the exact pool vaults. No wallet ATA
 * is used as a staging account for harvested yield. */
export async function buildCompoundSwapPlan(input: {
  connection: Connection; state: CompoundPositionState; accounts: [CompoundAccount, CompoundAccount];
  poolInfo: SimpleClmmPoolInfo; poolKeys: ClmmKeys; computePoolInfo: ComputeClmmPoolInfo;
  tickData: ReturnTypeFetchMultiplePoolTickArrays; amountA: bigint; amountB: bigint;
}) {
  const { connection, state, accounts, computePoolInfo, amountA, amountB } = input;
  const price = BigInt(computePoolInfo.sqrtPriceX64.toString());
  const lower = BigInt(state.lowerSqrtX64), upper = BigInt(state.upperSqrtX64);
  const baseline = sizeCompoundLiquidity(price, lower, upper, amountA, amountB, BigInt(state.liquidity));
  const p = price < lower ? lower : price > upper ? upper : price;
  const difference = amountA * (p - lower) * upper * p - amountB * (1n << 128n) * (upper - p);
  const empty = { instructions: [], route: null, swap: null, quotedBalances: { a: amountA, b: amountB }, sqrtPriceAfterX64: price };
  if (difference === 0n) return empty;
  const inputA = difference > 0n, source = accounts[inputA ? 0 : 1], destination = accounts[inputA ? 1 : 0];
  const budget = inputA ? amountA : amountB;
  if (budget === 0n) return empty;
  const config = await resolveSwapFeeConfig(connection, new PublicKey(source.mint), new PublicKey(source.program));
  const constraints = ownPoolConstraints();
  const validate = (route: Parameters<typeof assertOwnPoolRoute>[0]) => assertOwnPoolRoute(route, state.poolId);
  const evaluate = async (gross: bigint) => {
    const { swapAmount, feeAmount } = netSwapInput(gross, config.bps);
    // Dust-sized probes (e.g. 1 raw unit) legitimately have no route; treat as "no swap at this size".
    const route = swapAmount > 0n ? await quoteRoute(source.mint, destination.mint, swapAmount, constraints).catch((error: unknown) => {
      if (error instanceof JupiterHttpError && error.status === 400 && /^no routes found$|^cannot compute other amount threshold/i.test(error.bodyError ?? "")) return null;
      throw error;
    }) : null;
    if (route) validate(route);
    const output = route ? BigInt(route.otherAmountThreshold) : 0n;
    const sqrt = route ? BigInt(SqrtPriceMath.getNextSqrtPriceFromInput(new BN(price.toString()),
      computePoolInfo.liquidity, new BN(swapAmount.toString()), inputA).toString()) : price;
    const a = inputA ? amountA - gross : amountA + output;
    const b = inputA ? amountB + output : amountB - gross;
    const clamped = sqrt < lower ? lower : sqrt > upper ? upper : sqrt;
    return { gross, swapAmount, feeAmount, route, a, b, sqrt,
      difference: a * (clamped - lower) * upper * clamped - b * (1n << 128n) * (upper - clamped),
      sized: sizeCompoundLiquidity(sqrt, lower, upper, a, b, BigInt(state.liquidity)) };
  };
  let low = 0n, high = budget;
  let best = await evaluate(0n);
  // Bound upstream calls; final simulation sizes liquidity from actual balances.
  for (let i = 0; i < 10 && low <= high; i++) {
    const mid = (low + high) / 2n;
    const result = await evaluate(mid);
    if (result.sized.liquidity > best.sized.liquidity) best = result;
    const excess = inputA ? result.difference >= 0n : result.difference <= 0n;
    if (excess) low = mid + 1n;
    else high = mid - 1n;
  }
  const full = await evaluate(budget);
  if (full.sized.liquidity > best.sized.liquidity) best = full;
  if (!best.route) {
    if (baseline.liquidity === 0n) throw new Error("No protected Jupiter yield swap can form liquidity");
    return empty;
  }
  const route = await buildRoute(state.wallet, source.mint, destination.mint, best.swapAmount, false,
    constraints, undefined, undefined, destination.address);
  validate(route);
  const wallet = new PublicKey(state.wallet);
  const sourceAta = getAssociatedTokenAddressSync(new PublicKey(source.mint), wallet, false, new PublicKey(source.program)).toBase58();
  // Jupiter v1 has no sourceTokenAccount parameter. Retarget the exact user
  // source ATA in its instructions, never fund or drain an existing wallet ATA.
  // Reject unexpected setup/cleanup instead of guessing their side effects.
  if (route.cleanupInstruction || route.otherInstructions.length || route.setupInstructions.some(ix =>
    ix.programId !== "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" || ix.accounts[1]?.pubkey !== sourceAta))
    throw new Error("Compound Jupiter route contains unsupported setup or cleanup");
  if (!route.swapInstruction.accounts.some(key => key.pubkey === sourceAta && key.isWritable) ||
    !route.swapInstruction.accounts.some(key => key.pubkey === destination.address && key.isWritable))
    throw new Error("Compound Jupiter route does not identify isolated swap recipients");
  route.setupInstructions = [];
  route.swapInstruction = { ...route.swapInstruction, accounts: route.swapInstruction.accounts.map(key =>
    key.pubkey === sourceAta ? { ...key, pubkey: source.address } : key) };
  const swap: CompoundSwap = { inputMint: source.mint, outputMint: destination.mint,
    inputAmount: best.swapAmount.toString(), quotedOutputAmount: route.outAmount, minOutputAmount: route.otherAmountThreshold,
    inputDecimals: inputA ? state.decimalsA : state.decimalsB, outputDecimals: inputA ? state.decimalsB : state.decimalsA,
    poolId: state.poolId, sqrtPriceAfterX64: best.sqrt.toString(), feeBps: config.bps, feeAmount: best.feeAmount.toString() };
  const instructions = swapRouteInstructions([route], wallet);
  await rejectUnselectedWalletTokenWrites(connection, wallet, instructions, accounts.map(account => account.address));
  return { instructions, route, swap,
    quotedBalances: { a: best.a, b: best.b }, sqrtPriceAfterX64: best.sqrt };
}
