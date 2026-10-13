import "server-only";
import { USDC_MINT } from "../ids";
import type { JupiterRouteConstraints } from "../jupiter-route-retry";
import type { JupiterRetryBudget } from "../jupiter/client";
import { netSwapInput, type SwapFeeConfig } from "./fee";
import { buildRoute, quoteRoute } from "./jupiter";

/** A USDC deposit pays once, including the same-mint portion and secondary leg. */
export function depositFeePlan(mint: string, amount: bigint, config: SwapFeeConfig) {
  const upfront = mint === USDC_MINT ? netSwapInput(amount, config.bps) : { feeAmount: 0n, swapAmount: amount };
  return { ...upfront, legBps: mint === USDC_MINT ? 0 : config.bps, secondaryBps: mint === USDC_MINT ? 0 : config.bps };
}

export async function feeSwapLeg(input: {
  wallet: string; inputMint: string; outputMint: string; spend: bigint; feeBps: number;
  native?: boolean; constraints?: JupiterRouteConstraints | number; build?: boolean;
  signal?: AbortSignal; budget?: JupiterRetryBudget;
}) {
  const { wallet, inputMint, outputMint, spend, feeBps } = input;
  if (spend <= 0n) throw new Error("Swap amount must be greater than zero");
  if (inputMint === outputMint) return { inputMint, outputMint, spend, feeAmount: 0n, minOut: spend, route: null };
  // Output fees are already reflected in Jupiter's output and threshold.
  const platformFeeBps = outputMint === USDC_MINT ? feeBps : 0;
  const { feeAmount, swapAmount } = netSwapInput(spend, platformFeeBps ? 0 : feeBps);
  const constraints = typeof input.constraints === "number" ? { maxAccounts: input.constraints } : input.constraints;
  const route = input.build !== false
    ? await buildRoute(wallet, inputMint, outputMint, swapAmount, input.native ?? false, input.constraints,
      input.signal, input.budget, undefined, platformFeeBps)
    : await quoteRoute(inputMint, outputMint, swapAmount, constraints, input.signal, input.budget, platformFeeBps);
  return { inputMint, outputMint, spend, feeAmount, minOut: BigInt(route.otherAmountThreshold), route };
}
