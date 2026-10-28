import { USDC_MINT } from "../ids";
import type { JupiterRouteConstraints } from "../jupiter-route-retry";
import type { JupiterRetryBudget } from "../jupiter/client";
import { netSwapInput, type SwapFeeConfig } from "./fee";
import { buildRoute, quoteRoute, type QuoteRoute } from "./jupiter";
import { isPoolTokenPair, preferOwnPoolRoute, type OwnPool } from "./own-pool";

/** Reserve the protocol fee once from the deposited input; swap legs are uncharged. */
export function depositFeePlan(_mint: string, amount: bigint, config: SwapFeeConfig) {
  const upfront = netSwapInput(amount, config.bps);
  return { ...upfront, legBps: 0, secondaryBps: 0 };
}

export async function feeSwapLeg(input: {
  wallet: string; inputMint: string; outputMint: string; spend: bigint; feeBps: number;
  native?: boolean; constraints?: JupiterRouteConstraints | number; build?: boolean;
  signal?: AbortSignal; budget?: JupiterRetryBudget; ownPool?: OwnPool; maxPriceImpactBps?: number;
  /** Build swap-instructions for this already-validated quote (same request) instead of re-quoting. */
  quote?: QuoteRoute | null;
}) {
  const { wallet, inputMint, outputMint, spend, feeBps } = input;
  if (spend <= 0n) throw new Error("Swap amount must be greater than zero");
  if (inputMint === outputMint) return { inputMint, outputMint, spend, feeAmount: 0n, minOut: spend, route: null };
  // Output fees are already reflected in Jupiter's output and threshold.
  const platformFeeBps = outputMint === USDC_MINT ? feeBps : 0;
  const { feeAmount, swapAmount } = netSwapInput(spend, platformFeeBps ? 0 : feeBps);
  const constraints = typeof input.constraints === "number" ? { maxAccounts: input.constraints } : input.constraints;
  const request = (routeConstraints = constraints) => input.build !== false
    ? buildRoute(wallet, inputMint, outputMint, swapAmount, input.native ?? false, routeConstraints,
      input.signal, input.budget, undefined, platformFeeBps, ...(input.maxPriceImpactBps === undefined ? [] : [input.maxPriceImpactBps]))
    : quoteRoute(inputMint, outputMint, swapAmount, routeConstraints, input.signal, input.budget, platformFeeBps, ...(input.maxPriceImpactBps === undefined ? [] : [input.maxPriceImpactBps]));
  if (input.quote && input.build !== false) {
    if (input.quote.inputMint !== inputMint || input.quote.outputMint !== outputMint || BigInt(input.quote.inAmount) !== swapAmount) {
      throw new Error("Swap route does not match selected assets or pool");
    }
    const route = await buildRoute(wallet, inputMint, outputMint, swapAmount, input.native ?? false, constraints, input.signal,
      input.budget, undefined, platformFeeBps, input.maxPriceImpactBps, input.quote);
    return { inputMint, outputMint, spend, feeAmount, minOut: BigInt(route.otherAmountThreshold), route };
  }
  const route = input.ownPool && isPoolTokenPair(input.ownPool, inputMint, outputMint)
    ? await preferOwnPoolRoute(input.ownPool.poolId, request, constraints)
    : await request();
  return { inputMint, outputMint, spend, feeAmount, minOut: BigInt(route.otherAmountThreshold), route };
}
