import { NATIVE_SOL_MINT, USDC_MINT } from "../ids";
import type { JupiterRouteConstraints } from "../jupiter-route-retry";
import type { JupiterRetryBudget } from "../jupiter/client";
import { computeSwapFee, netSwapInput, type SwapFeeConfig } from "./fee";
import { buildRoute, quoteRoute, type QuoteRoute } from "./jupiter";
import { diagJupiterWrap } from "../diag";
import { isPoolTokenPair, preferOwnPoolRoute, type OwnPool } from "./own-pool";

/** Token deposits reserve the protocol fee once from the input (a separate
 * TransferChecked); swap legs are uncharged. Native SOL deposits reserve
 * nothing up front: every SOL-input swap leg carries Jupiter `platformFeeBps`
 * in the input mint (wSOL), so the whole SOL input is charged 10 bps inside
 * the swaps (`inputFee`). */
export function depositFeePlan(mint: string, amount: bigint, config: SwapFeeConfig, inputKind: "native" | "token" = "token") {
  if (inputKind === "native" && mint === NATIVE_SOL_MINT && config.bps > 0) {
    return { feeAmount: 0n, swapAmount: amount, legBps: config.bps, secondaryBps: 0, inputFee: true };
  }
  const upfront = netSwapInput(amount, config.bps);
  return { ...upfront, legBps: 0, secondaryBps: 0, inputFee: false };
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
  /** Native SOL deposit: charge `feeBps` as Jupiter platform fee in the input
   * mint (wSOL) on the full `spend`; the route's inAmount is the gross spend. */
  inputFee?: boolean;
}) {
  const { wallet, inputMint, outputMint, spend, feeBps } = input;
  // DIAG ONLY (v2): Jupiter wraps/unwraps native SOL itself.
  if (input.native === undefined && diagJupiterWrap() && inputMint === NATIVE_SOL_MINT) input = { ...input, native: true };
  if (spend <= 0n) throw new Error("Swap amount must be greater than zero");
  if (inputMint === outputMint) return { inputMint, outputMint, spend, feeAmount: 0n, feeInRoute: false, minOut: spend, route: null };
  const inputFee = Boolean(input.inputFee) && feeBps > 0 && inputMint === NATIVE_SOL_MINT;
  // Output (USDC) and input (wSOL) platform fees are reflected in Jupiter's
  // output and threshold; only other fees are reserved from the spend.
  const platformFeeBps = inputFee || outputMint === USDC_MINT ? feeBps : 0;
  const feeMint = inputFee ? NATIVE_SOL_MINT : USDC_MINT;
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
