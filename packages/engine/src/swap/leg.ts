import { NATIVE_SOL_MINT, USDC_MINT } from "../ids";
import type { JupiterRouteConstraints } from "../jupiter-route-retry";
import type { JupiterRetryBudget } from "../jupiter/client";
import { computeSwapFee, netSwapInput, type SwapFeeConfig } from "./fee";
import { buildRoute, quoteRoute, type QuoteRoute } from "./jupiter";
import { isPoolTokenPair, preferOwnPoolRoute, type OwnPool } from "./own-pool";

/** Deposits reserve nothing up front: every swap leg from the input mint
 * (SOL, USDC, stock tokens) carries Jupiter `platformFeeBps` in the input mint,
 * paid into the fee wallet's pre-created ATA for that mint (`inputFee`). The
 * part of a deposit kept as-is (the input is itself a pool token) is not
 * swapped and not charged. There is no separate fee transfer. */
export function depositFeePlan(amount: bigint, config: SwapFeeConfig) {
  if (config.bps > 0) return { feeAmount: 0n, swapAmount: amount, legBps: config.bps, secondaryBps: 0, inputFee: true };
  return { feeAmount: 0n, swapAmount: amount, legBps: 0, secondaryBps: 0, inputFee: false };
}

/** Native SOL input pays its fee only inside swaps, so any SOL kept as SOL
 * (pools that contain wSOL) would go uncharged. Refuse rather than charge less
 * or fall back to a direct transfer. */
export function assertNativeInputFeeCoverage(inputFee: boolean, legs: { inputMint: string; outputMint: string; spend: bigint }[]) {
  if (inputFee && legs.some(item => item.inputMint === NATIVE_SOL_MINT && item.outputMint === NATIVE_SOL_MINT && item.spend > 0n)) {
    throw new Error("SOL input is not available for pools that contain SOL yet. Please use another token.");
  }
}

export async function feeSwapLeg(input: {
  wallet: string; inputMint: string; outputMint: string; spend: bigint; feeBps: number;
  native?: boolean; constraints?: JupiterRouteConstraints | number; build?: boolean;
  signal?: AbortSignal; budget?: JupiterRetryBudget; ownPool?: OwnPool; maxPriceImpactBps?: number;
  /** Build swap-instructions for this already-validated quote (same request) instead of re-quoting. */
  quote?: QuoteRoute | null;
  /** Deposit leg: charge `feeBps` as Jupiter platform fee in the input mint
   * (wSOL, USDC, stock token) on the full `spend`; the route's inAmount is the
   * gross spend. */
  inputFee?: boolean;
}) {
  const { wallet, inputMint, outputMint, spend, feeBps } = input;
  if (spend <= 0n) throw new Error("Swap amount must be greater than zero");
  if (inputMint === outputMint) return { inputMint, outputMint, spend, feeAmount: 0n, feeInRoute: false, minOut: spend, route: null };
  const inputFee = Boolean(input.inputFee) && feeBps > 0;
  // Output (USDC) and input-mint platform fees are reflected in Jupiter's
  // output and threshold; only other fees are reserved from the spend.
  const platformFeeBps = inputFee || outputMint === USDC_MINT ? feeBps : 0;
  const feeMint = inputFee ? inputMint : USDC_MINT;
  // Jupiter takes floor(inAmount * bps / 10_000) of the input mint for ExactIn.
  const { feeAmount, swapAmount } = inputFee
    ? { feeAmount: computeSwapFee(spend, feeBps), swapAmount: spend }
    : netSwapInput(spend, platformFeeBps ? 0 : feeBps);
  const feeInRoute = inputFee;
  const constraints = typeof input.constraints === "number" ? { maxAccounts: input.constraints } : input.constraints;
  const request = (routeConstraints = constraints) => input.build !== false
    ? buildRoute(wallet, inputMint, outputMint, swapAmount, input.native ?? false, routeConstraints,
      input.signal, input.budget, undefined, platformFeeBps, input.maxPriceImpactBps, undefined, feeMint)
    : quoteRoute(inputMint, outputMint, swapAmount, routeConstraints, input.signal, input.budget, platformFeeBps, ...(input.maxPriceImpactBps === undefined ? [] : [input.maxPriceImpactBps]));
  if (input.quote && input.build !== false) {
    if (input.quote.inputMint !== inputMint || input.quote.outputMint !== outputMint || BigInt(input.quote.inAmount) !== swapAmount) {
      throw new Error("Swap route does not match selected assets or pool");
    }
    const route = await buildRoute(wallet, inputMint, outputMint, swapAmount, input.native ?? false, constraints, input.signal,
      input.budget, undefined, platformFeeBps, input.maxPriceImpactBps, input.quote, feeMint);
    return { inputMint, outputMint, spend, feeAmount, feeInRoute, minOut: BigInt(route.otherAmountThreshold), route };
  }
  const route = input.ownPool && isPoolTokenPair(input.ownPool, inputMint, outputMint)
    ? await preferOwnPoolRoute(input.ownPool.poolId, request, constraints)
    : await request();
  return { inputMint, outputMint, spend, feeAmount, feeInRoute, minOut: BigInt(route.otherAmountThreshold), route };
}
