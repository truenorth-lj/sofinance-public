import "@/lib/engine-host";
import "server-only";

import { readSwapFeeConfig } from "@sofinance/engine/swap/fee";
import { depositFeePlan, feeSwapLeg } from "@sofinance/engine/swap/leg";
import BN from "bn.js";
import { LiquidityMathUtil, SqrtPriceMath, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { DEFAULT_ADD_TOLERANCE_BPS, DEFAULT_RESALE_FLOOR_BPS, MAX_PRICE_IMPACT_BPS, QUOTE_TTL_MS, SLIPPAGE_BPS } from "@sofinance/engine/ids";
import { describeResaleFloorFailure, meetsResaleFloor, parseAddToleranceBps, parseResaleFloorBps, parseTokenAmount } from "@sofinance/engine/amount";
import { allocateSpend, padAmountMax, poolPriceRates, positionSide, toleranceLiquidity } from "@sofinance/engine/quote-math";
import { type QuoteRoute } from "@sofinance/engine/swap/jupiter";
import type { Connection } from "@solana/web3.js";
import type { JupiterRouteConstraints } from "@sofinance/engine/jupiter-route-retry";
import { jupiterRelayHint, setJupiterRelayHint, type JupiterRetryBudget } from "@sofinance/engine/jupiter/client";
import { isJupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import { readSelectedPositionState, type PositionSelection, type SelectedPositionState } from "@sofinance/engine/selected-state";
import { selectedNoRouteError } from "./selected-no-route";
import { AmountTooSmallError, isJupiterAmountTooSmallHttp, minJupiterSwapAmount } from "./selected-amount-error";
import { withSelectedRouteRetries } from "./selected-route-retry";
import { CROSS_LIQUIDITY_BAND_MESSAGE, staysInLiquidityBand } from "@sofinance/engine/liquidity-band";

const MIN_JUPITER_SWAP = minJupiterSwapAmount(SLIPPAGE_BPS);

type SwapLeg = { inputMint: string; outputMint: string; spend: bigint; feeAmount: bigint; minOut: bigint; route: QuoteRoute | null };

function projectedSqrt(state: SelectedPositionState, routes: QuoteRoute[]): BN {
  let price = new BN(state.sqrtPriceX64);
  const liquidity = new BN(state.poolLiquidity);
  let targetHops = 0;
  for (const route of routes) for (const leg of route.routePlan) {
    if (leg.swapInfo.ammKey !== state.poolId) continue;
    targetHops++;
    if (targetHops > 1 || leg.bps !== 10_000) throw new Error("Target pool route too complex, cannot conservatively estimate pre-add price");
    const zeroForOne = leg.swapInfo.inputMint === state.mintA && leg.swapInfo.outputMint === state.mintB;
    const oneForZero = leg.swapInfo.inputMint === state.mintB && leg.swapInfo.outputMint === state.mintA;
    if (!zeroForOne && !oneForZero) throw new Error("Target pool route asset mismatch");
    price = SqrtPriceMath.getNextSqrtPriceFromInput(price, liquidity, new BN(leg.swapInfo.inAmount), zeroForOne);
  }
  if (positionSide(BigInt(price.toString()), BigInt(state.lowerSqrtX64), BigInt(state.upperSqrtX64)) !== state.rangeSide) {
    throw new Error("Swap may cause target pool price to cross position boundary, please re-quote");
  }
  // Liquidity is constant only inside the current tick-spacing band (initialized ticks sit on its edges).
  if (!staysInLiquidityBand(state.sqrtPriceX64, price, state.tickCurrent, state.tickSpacing)) throw new Error(CROSS_LIQUIDITY_BAND_MESSAGE);
  return price;
}

function amountsAt(state: SelectedPositionState, sqrt: BN, liquidity: BN) {
  return LiquidityMathUtil.getAmountsForLiquidity(sqrt, new BN(state.lowerSqrtX64), new BN(state.upperSqrtX64), liquidity, true);
}

function dummyLeg(inputMint: string, outputMint: string, spend: bigint, minOut = 0n): SwapLeg {
  return { inputMint, outputMint, spend, feeAmount: 0n, minOut, route: null };
}

function requiresJupiterQuote(inputMint: string, outputMint: string, spend: bigint) {
  return spend > 0n && inputMint !== outputMint;
}

function isUnquoteableJupiterSpend(inputMint: string, outputMint: string, spend: bigint) {
  return requiresJupiterQuote(inputMint, outputMint, spend) && spend < MIN_JUPITER_SWAP;
}

function remapAmountTooSmall(error: unknown): never {
  if (isJupiterAmountTooSmallHttp(error)) throw new AmountTooSmallError();
  if (error instanceof Error && /too small|below/i.test(error.message) && /single-side amount|probe route/i.test(error.message)) {
    throw new AmountTooSmallError();
  }
  throw error;
}

async function leg(
  wallet: string, inputMint: string, outputMint: string, spend: bigint, nativeSource = false,
  jupiter?: JupiterRouteConstraints, build = false, signal?: AbortSignal, budget?: JupiterRetryBudget, feeBps = 0,
  ownPool?: { poolId: string; mintA: string; mintB: string }, quote?: QuoteRoute | null,
): Promise<SwapLeg> {
  if (spend <= 0n) return dummyLeg(inputMint, outputMint, spend);
  if (isUnquoteableJupiterSpend(inputMint, outputMint, spend)) throw new AmountTooSmallError();
  return feeSwapLeg({ wallet, inputMint, outputMint, spend, feeBps, native: nativeSource,
    constraints: jupiter, build, signal, budget, ownPool, quote });
}

export async function getSelectedQuoteBundle(
  wallet: string, selection: PositionSelection, amount: string,
  requestedFloorBps = DEFAULT_RESALE_FLOOR_BPS, requestedToleranceBps = DEFAULT_ADD_TOLERANCE_BPS,
  jupiter?: JupiterRouteConstraints,
  options: { buildTransactions?: boolean; includeResale?: boolean; signal?: AbortSignal;
    budget?: JupiterRetryBudget; connection?: Connection; state?: SelectedPositionState } = {},
) {
  try {
    return await getSelectedQuoteBundleOnce(
      wallet, selection, amount, requestedFloorBps, requestedToleranceBps, jupiter, options);
  } catch (error) {
    remapAmountTooSmall(error);
  }
}

async function getSelectedQuoteBundleOnce(
  wallet: string, selection: PositionSelection, amount: string,
  requestedFloorBps: number, requestedToleranceBps: number,
  jupiter: JupiterRouteConstraints | undefined,
  options: { buildTransactions?: boolean; includeResale?: boolean; signal?: AbortSignal;
    budget?: JupiterRetryBudget; connection?: Connection; state?: SelectedPositionState },
) {
  const floorBps = parseResaleFloorBps(requestedFloorBps);
  const toleranceBps = parseAddToleranceBps(requestedToleranceBps);
  const state = options.state ?? await readSelectedPositionState(wallet, selection, options.connection, false, { displayPrices: false });
  if (state.inputKind === "native" && state.wsolBalance !== "0") throw new Error("Native SOL input already has WSOL ATA balance, please handle separately to avoid using existing WSOL");
  const feeConfig = readSwapFeeConfig();
  // Sizing rounds are quote-only. Once converged, the final legs are built from
  // the very quotes that sized them (swap-instructions only, no re-quote).
  const actualLeg = (outputMint: string, spend: bigint) => leg(wallet, state.inputMint, outputMint, spend,
    state.inputKind === "native", jupiter, false, options.signal, options.budget, deposit.legBps, state);
  const buildLeg = async (sized: SwapLeg) => options.buildTransactions === false || !sized.route ? sized
    : await leg(wallet, sized.inputMint, sized.outputMint, sized.spend, state.inputKind === "native", jupiter, true,
      options.signal, options.budget, deposit.legBps, state, sized.route);
  if (!state.ownsNft) throw new Error("Wallet does not have an available position NFT ATA for the selected position");
  if (state.paused || state.frozen || state.transferFee || state.unsupportedExtensions.length) {
    throw new Error(`Pool asset currently paused, account frozen, transfer fee charged, or has unsupported settings${state.unsupportedExtensions.length ? `: ${state.unsupportedExtensions.join(", ")}` : ""}`);
  }
  if (!state.sufficientSol) throw new Error("Insufficient SOL, reserve at least 0.01 SOL to pay network fees and possible ATA rent");
  const grossRequested = parseTokenAmount(amount, state.inputDecimals);
  const deposit = depositFeePlan(state.inputMint, grossRequested, feeConfig);
  const requested = deposit.swapAmount;
  if (BigInt(state.inputBalance) < grossRequested) throw new Error("Insufficient input asset balance or SOL reserve");
  if (requested <= 0n) throw new AmountTooSmallError();
  let spendA = 0n;
  let legs: SwapLeg[] = [];
  let projected = new BN(state.sqrtPriceX64);
  if (state.rangeSide !== "inside") {
    const outputMint = state.rangeSide === "below" ? state.mintA : state.mintB;
    // Price impact is capped on Jupiter's own priceImpactPct (quote guards); no probe quote.
    const actual = await actualLeg(outputMint, requested);
    legs = [await buildLeg(actual)];
    spendA = outputMint === state.mintA ? requested : 0n;
    projected = projectedSqrt(state, actual.route ? [actual.route] : []);
  } else {
    // First allocation at the pool price instead of 1/10-size probe quotes.
    const base = amountsAt(state, projected, new BN("1000000000000000000"));
    const rates = poolPriceRates(state.sqrtPriceX64);
    // With browser-relayed Jupiter, restart from the last allocation tried (its quotes are already
    // in the browser) so pool-price drift between rounds does not force fresh quotes every round.
    const hintKey = `selected:${state.positionMint}:${state.inputMint}:${requested}:${JSON.stringify(jupiter ?? null)}`;
    const hinted = jupiterRelayHint(hintKey);
    spendA = hinted !== undefined && hinted > 0n && hinted < requested ? hinted
      : allocateSpend(requested, BigInt(base.amountA.toString()), BigInt(base.amountB.toString()), rates.rateA, rates.rateB, 1n);
    for (let index = 0; index < 5; index++) {
      setJupiterRelayHint(hintKey, spendA);
      const [actualA, actualB] = await Promise.all([
        actualLeg(state.mintA, spendA), actualLeg(state.mintB, requested - spendA),
      ]);
      legs = [actualA, actualB];
      projected = projectedSqrt(state, legs.flatMap((item) => item.route ? [item.route] : []));
      const desired = amountsAt(state, projected, new BN("1000000000000000000"));
      const next = allocateSpend(requested, BigInt(desired.amountA.toString()), BigInt(desired.amountB.toString()),
        { spend: spendA, out: actualA.minOut }, { spend: requested - spendA, out: actualB.minOut }, 1n);
      const difference = next > spendA ? next - spendA : spendA - next;
      if (difference * 1_000n <= requested * 2n) break;
      if (index === 4) throw new Error("Pool price and swap ratio did not converge, please retry later");
      spendA = next;
    }
    legs = await Promise.all(legs.map(buildLeg));
  }
  if (deposit.feeAmount > 0n) {
    legs[0]!.spend += deposit.feeAmount;
    legs[0]!.feeAmount += deposit.feeAmount;
  }
  const outA = legs.find((item) => item.outputMint === state.mintA)?.minOut || 0n;
  const outB = legs.find((item) => item.outputMint === state.mintB)?.minOut || 0n;
  const fullLiquidity = LiquidityMathUtil.getLiquidityFromAmounts(projected,
    new BN(state.lowerSqrtX64), new BN(state.upperSqrtX64), new BN(outA.toString()), new BN(outB.toString()));
  fullLiquidity.isubn(1);
  const liquidity = new BN(toleranceLiquidity(BigInt(fullLiquidity.toString()), toleranceBps).toString());
  if (liquidity.lten(0)) throw new AmountTooSmallError();
  const amounts = amountsAt(state, projected, liquidity);
  const requiredA = BigInt(amounts.amountA.toString());
  const requiredB = BigInt(amounts.amountB.toString());
  if (requiredA > outA || requiredB > outB) throw new Error("amountMax exceeds conservative swap minOut");
  const amountMaxA = padAmountMax(requiredA, outA, toleranceBps);
  const amountMaxB = padAmountMax(requiredB, outB, toleranceBps);
  // Value everything the wallet ends up with: the position deposit plus the
  // tolerance reserve that stays in the wallet as pool assets. The reserve is
  // not lost, so it must not count against the resale floor; the floor still
  // gates swap round-trip cost and price impact on the full swap output.
  const includeResale = options.includeResale !== false;
  const resaleLegs = includeResale ? await Promise.all([
    outA > 0n && !isUnquoteableJupiterSpend(state.mintA, state.inputMint, outA)
      ? leg(wallet, state.mintA, state.inputMint, outA, false, jupiter, false, options.signal, options.budget) : null,
    outB > 0n && !isUnquoteableJupiterSpend(state.mintB, state.inputMint, outB)
      ? leg(wallet, state.mintB, state.inputMint, outB, false, jupiter, false, options.signal, options.budget) : null,
  ]) : [];
  const resale = resaleLegs.reduce((sum, item) => sum + (item?.minOut || 0n), 0n);
  const timestamp = Date.now();
  const floorAdvice = describeResaleFloorFailure(grossRequested, resale, floorBps);
  const passesFloor = includeResale && meetsResaleFloor(grossRequested, resale, floorBps);
  const quote = {
    feeBps: feeConfig.bps, feeWallet: feeConfig.wallet?.toBase58() ?? null,
    feeAmount: legs.reduce((sum, item) => sum + item.feeAmount, 0n).toString(),
    wallet, inputMint: state.inputMint, inputKind: state.inputKind, inputDecimals: state.inputDecimals,
    positionMint: state.positionMint, positionAccount: state.positionAccount, poolId: state.poolId,
    mintA: state.mintA, mintB: state.mintB, decimalsA: state.decimalsA, decimalsB: state.decimalsB,
    rangeSide: state.rangeSide, requested: grossRequested.toString(), spendA: (spendA + (legs[0]?.outputMint === state.mintA ? deposit.feeAmount : 0n)).toString(),
    spendB: (grossRequested - spendA - (legs[0]?.outputMint === state.mintA ? deposit.feeAmount : 0n)).toString(), minOutA: outA.toString(), minOutB: outB.toString(),
    liquidity: liquidity.toString(), amountMaxA: amountMaxA.toString(), amountMaxB: amountMaxB.toString(),
    requiredA: requiredA.toString(), requiredB: requiredB.toString(), toleranceBps,
    dustA: (outA - requiredA).toString(), dustB: (outB - requiredB).toString(),
    resaleInput: includeResale ? resale.toString() : null, minimumResaleInput: includeResale ? ((grossRequested * BigInt(floorBps) + 9_999n) / 10_000n).toString() : null,
    roundtripCostInput: includeResale ? (grossRequested > resale ? grossRequested - resale : 0n).toString() : null,
    projectedPrice: TickUtil.sqrtPriceX64ToPrice(projected, state.decimalsA, state.decimalsB).toString(),
    slot: state.slot, fetchedAt: timestamp, expiresAt: timestamp + QUOTE_TTL_MS,
    passesFloor, floorBps,
    suggestedResaleFloorBps: includeResale ? floorAdvice.suggestedResaleFloorBps : null,
    maxAmountForFloor: includeResale ? floorAdvice.maxAmountForFloor : null,
    achievedResaleBps: includeResale ? floorAdvice.achievedResaleBps : null,
    warning: !includeResale || passesFloor ? "" : floorAdvice.warning,
    maxImpactBps: MAX_PRICE_IMPACT_BPS, slippageBps: SLIPPAGE_BPS,
    routeTouchesTargetPool: legs.some((item) => item.route?.routePlan.some((hop) => hop.swapInfo.ammKey === state.poolId)),
  };
  return { quote, legs, state };
}

/** Compact-first quote with wider Jupiter budgets when the compact hop has no route. */
export async function searchSelectedQuoteBundle(
  wallet: string, selection: PositionSelection, amount: string,
  requestedFloorBps = DEFAULT_RESALE_FLOOR_BPS, requestedToleranceBps = DEFAULT_ADD_TOLERANCE_BPS,
  options: { buildTransactions?: boolean; includeResale?: boolean; signal?: AbortSignal;
    budget?: JupiterRetryBudget; connection?: Connection; state?: SelectedPositionState } = {},
) {
  const state = options.state ?? await readSelectedPositionState(wallet, selection, options.connection, false, { displayPrices: false });
  try {
    return await withSelectedRouteRetries((jupiter) => getSelectedQuoteBundle(
      wallet, selection, amount, requestedFloorBps, requestedToleranceBps, jupiter, { ...options, state }));
  } catch (error) {
    if (isJupiterNoRouteError(error)) throw selectedNoRouteError(state);
    throw error;
  }
}

export type SelectedQuote = Awaited<ReturnType<typeof getSelectedQuoteBundle>>["quote"];
