import "@/lib/engine-host";
import "server-only";
import { knownTokenSymbol, NOT_ENOUGH_SOL_FOR_FEES_MESSAGE, notEnoughBalanceMessage } from "@sofinance/engine/balance-message";

import { readSwapFeeConfig } from "@sofinance/engine/swap/fee";
import { assertNativeInputFeeCoverage, depositFeePlan, feeSwapLeg } from "@sofinance/engine/swap/leg";
import BN from "bn.js";
import { LiquidityMathUtil, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { DEFAULT_ADD_TOLERANCE_BPS, DEFAULT_RESALE_FLOOR_BPS, MAX_PRICE_IMPACT_BPS, QUOTE_TTL_MS, SLIPPAGE_BPS } from "@sofinance/engine/ids";
import { describeResaleFloorFailure, formatAmount, meetsResaleFloor, parseAddToleranceBps, parseResaleFloorBps, parseTokenAmount } from "@sofinance/engine/amount";
import { allocateSpend, padAmountMax, poolPriceRates, toleranceLiquidity } from "@sofinance/engine/quote-math";
import { type QuoteRoute } from "@sofinance/engine/swap/jupiter";
import type { Connection } from "@solana/web3.js";
import type { JupiterRouteConstraints } from "@sofinance/engine/jupiter-route-retry";
import { jupiterRelayHint, setJupiterRelayHint, type JupiterRetryBudget } from "@sofinance/engine/jupiter/client";
import { isJupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import { readSelectedPositionState, type PositionSelection, type SelectedPositionState } from "@sofinance/engine/selected-state";
import { selectedNoRouteError } from "./selected-no-route";
import { AmountTooSmallError, formatAmountTooSmallMessage, formatSmallLegMovesPriceMessage, isJupiterAmountTooSmallHttp,
  minJupiterSwapAmount, SmallLegMovesPriceError } from "./selected-amount-error";
import { tokenSymbol } from "./position-label";
import { withSelectedRouteRetries } from "./selected-route-retry";
import { CROSS_LIQUIDITY_BAND_MESSAGE, CROSS_POSITION_RANGE_MESSAGE } from "@sofinance/engine/liquidity-band";
import { projectTargetPoolSqrt } from "@sofinance/engine/target-pool-projection";

const MIN_JUPITER_SWAP = minJupiterSwapAmount(SLIPPAGE_BPS);
/**
 * A swap leg below this share of the deposit is raised to it (never below Jupiter's 200-unit floor, capped at
 * 100x that floor). Narrow ranges at their edge need almost only one pool token, so the other token's leg can
 * fall below what Jupiter can quote; a slightly larger leg is quotable and its unused output simply stays in the
 * wallet with the price-tolerance reserve. 1 bps keeps that surplus to at most 0.01% of the deposit.
 */
export const SMALL_LEG_FLOOR_BPS = 1n;
const SMALL_LEG_FLOOR_CAP = MIN_JUPITER_SWAP * 100n;
/** A pool token under this share of the deposit means the position is nearly one-sided. */
const NEARLY_ONE_SIDED_BPS = 100n;

/** Smallest swap leg (raw input units) sized for a deposit of `requested`. */
export function minorityLegFloor(requested: bigint): bigint {
  const share = requested * SMALL_LEG_FLOOR_BPS / 10_000n;
  if (share < MIN_JUPITER_SWAP) return MIN_JUPITER_SWAP;
  return share > SMALL_LEG_FLOOR_CAP ? SMALL_LEG_FLOOR_CAP : share;
}

type InsideFloors = { a: bigint; b: bigint; quoteA: boolean; quoteB: boolean };

/** Per-side minimum spend for an in-range add: each side needs some of its token; a swapped side needs a quotable leg. */
function insideFloors(inputMint: string, mintA: string, mintB: string, requested: bigint,
  floor = minorityLegFloor(requested)): InsideFloors {
  const quoteA = inputMint !== mintA, quoteB = inputMint !== mintB;
  return { a: quoteA ? floor : 1n, b: quoteB ? floor : 1n, quoteA, quoteB };
}

/**
 * Raise a dust-sized leg (0 <= spend < floor) to its floor, taking the difference from the other leg. Sizing
 * stays converged: the loop compares clamped allocations, and the bump is far below its 0.2% convergence step.
 */
export function clampInsideSpend(requested: bigint, spendA: bigint, floors: Pick<InsideFloors, "a" | "b">): bigint {
  let next = spendA < floors.a ? floors.a : spendA;
  if (requested - next < floors.b) next = requested - floors.b;
  return next;
}

/** Genuine too-small amount: state the real cause and the computed minimum (raw input units). */
function amountTooSmall(state: SelectedPositionState, minimum: bigint,
  minorityMint: string, majorityMint?: string): AmountTooSmallError {
  const input = state.inputKind === "native" ? "SOL" : tokenSymbol(state.inputMint);
  const message = formatAmountTooSmallMessage({ input, minority: tokenSymbol(minorityMint),
    majority: majorityMint ? tokenSymbol(majorityMint) : undefined,
    minimum: formatAmount(minimum.toString(), state.inputDecimals, state.inputDecimals) });
  return new AmountTooSmallError({ minimumInput: minimum.toString(), inputDecimals: state.inputDecimals,
    minorityMint, ...(majorityMint ? { majorityMint } : {}) }, message);
}

/** The in-range deposit cannot cover both legs' floors; name the leg that is too small. */
function insideTooSmall(state: SelectedPositionState, requested: bigint, naturalA: bigint, floors: InsideFloors) {
  const minimum = (floors.quoteA ? MIN_JUPITER_SWAP : 1n) + (floors.quoteB ? MIN_JUPITER_SWAP : 1n);
  const naturalB = requested - naturalA;
  const minorityIsA = floors.quoteA && (!floors.quoteB || naturalA <= naturalB);
  const minoritySpend = minorityIsA ? naturalA : naturalB;
  const nearlyOneSided = minoritySpend * 10_000n < requested * NEARLY_ONE_SIDED_BPS;
  return amountTooSmall(state, minimum, minorityIsA ? state.mintA : state.mintB,
    nearlyOneSided ? (minorityIsA ? state.mintB : state.mintA) : undefined);
}

/** Even Jupiter's smallest quotable minority leg moves this thin pool's price too far: plain-English cause and next step. */
function smallLegMovesPrice(state: SelectedPositionState, minorityIsA: boolean): SmallLegMovesPriceError {
  const minorityMint = minorityIsA ? state.mintA : state.mintB, majorityMint = minorityIsA ? state.mintB : state.mintA;
  return new SmallLegMovesPriceError({ minorityMint, majorityMint }, formatSmallLegMovesPriceMessage({
    minority: tokenSymbol(minorityMint), majority: tokenSymbol(majorityMint) }));
}

type SwapLeg = { inputMint: string; outputMint: string; spend: bigint; feeAmount: bigint; feeInRoute?: boolean; minOut: bigint; route: QuoteRoute | null };

function projectedSqrt(state: SelectedPositionState, routes: QuoteRoute[]): BN {
  return projectTargetPoolSqrt({
    poolId: state.poolId, mintA: state.mintA, mintB: state.mintB,
    sqrtPriceX64: state.sqrtPriceX64, poolLiquidity: state.poolLiquidity,
    tickCurrent: state.tickCurrent, tickSpacing: state.tickSpacing,
    lowerSqrtX64: state.lowerSqrtX64, upperSqrtX64: state.upperSqrtX64,
    rangeSide: state.rangeSide, routes,
    complexError: () => new Error("Target pool route too complex, cannot conservatively estimate pre-add price"),
    rangeError: () => new PoolPriceMoveError(CROSS_POSITION_RANGE_MESSAGE),
    bandError: () => new PoolPriceMoveError(CROSS_LIQUIDITY_BAND_MESSAGE),
  });
}

/** The quoted swaps would move this pool's price out of the position range or the current liquidity band. */
class PoolPriceMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolPriceMoveError";
  }
}

/**
 * Minority-leg floors to try, largest first: the 1 bps floor, then three geometric steps down to Jupiter's 200-unit
 * minimum (e.g. 1502 → 767 → 392 → 200). A smaller bump is tried only when the larger one moves the pool price too far.
 */
export function smallLegFloorSteps(requested: bigint): bigint[] {
  const first = minorityLegFloor(requested);
  const steps = [first];
  const ratio = Number(MIN_JUPITER_SWAP) / Number(first);
  for (const k of [1, 2, 3]) {
    const next = k === 3 ? MIN_JUPITER_SWAP : BigInt(Math.max(Number(MIN_JUPITER_SWAP), Math.round(Number(first) * ratio ** (k / 3))));
    if (next < steps[steps.length - 1]!) steps.push(next);
  }
  return steps;
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
  ownPool?: { poolId: string; mintA: string; mintB: string }, quote?: QuoteRoute | null, inputFee = false,
): Promise<SwapLeg> {
  if (spend <= 0n) return dummyLeg(inputMint, outputMint, spend);
  if (isUnquoteableJupiterSpend(inputMint, outputMint, spend)) throw new AmountTooSmallError();
  return feeSwapLeg({ wallet, inputMint, outputMint, spend, feeBps, native: nativeSource,
    constraints: jupiter, build, signal, budget, ownPool, quote, inputFee });
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
  // Native SOL is wrapped once in selected-atomic (full input). Jupiter debits
  // each leg from that wSOL and takes the 10 bps input-mint platform fee inside
  // the swap; it must not wrap again.
  const actualLeg = (outputMint: string, spend: bigint) => leg(wallet, state.inputMint, outputMint, spend,
    false, jupiter, false, options.signal, options.budget, deposit.legBps, state, undefined, deposit.inputFee);
  const buildLeg = async (sized: SwapLeg) => options.buildTransactions === false || !sized.route ? sized
    : await leg(wallet, sized.inputMint, sized.outputMint, sized.spend, false, jupiter, true,
      options.signal, options.budget, deposit.legBps, state, sized.route, deposit.inputFee);
  if (!state.ownsNft) throw new Error("Wallet does not have an available position NFT ATA for the selected position");
  if (state.paused || state.frozen || state.transferFee || state.unsupportedExtensions.length) {
    throw new Error(`Pool asset currently paused, account frozen, transfer fee charged, or has unsupported settings${state.unsupportedExtensions.length ? `: ${state.unsupportedExtensions.join(", ")}` : ""}`);
  }
  if (!state.sufficientSol) throw new Error(NOT_ENOUGH_SOL_FOR_FEES_MESSAGE);
  const grossRequested = parseTokenAmount(amount, state.inputDecimals);
  const deposit = depositFeePlan(grossRequested, feeConfig);
  const requested = deposit.swapAmount;
  if (BigInt(state.inputBalance) < grossRequested) {
    throw new Error(notEnoughBalanceMessage({ symbol: knownTokenSymbol(state.inputMint, state.inputKind), decimals: state.inputDecimals,
      balance: state.inputBalance, requested: grossRequested, native: state.inputKind === "native" }));
  }
  if (requested <= 0n) throw new AmountTooSmallError();
  let spendA = 0n;
  let legs: SwapLeg[] = [];
  let projected = new BN(state.sqrtPriceX64);
  if (state.rangeSide !== "inside") {
    const outputMint = state.rangeSide === "below" ? state.mintA : state.mintB;
    if (isUnquoteableJupiterSpend(state.inputMint, outputMint, requested)) {
      throw amountTooSmall(state, MIN_JUPITER_SWAP, outputMint);
    }
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
    // Unclamped pool-price allocation; a side may round to 0 when the price sits at the range edge.
    const natural = allocateSpend(requested, BigInt(base.amountA.toString()), BigInt(base.amountB.toString()), rates.rateA, rates.rateB, 0n);
    const minimumFloors = insideFloors(state.inputMint, state.mintA, state.mintB, requested, MIN_JUPITER_SWAP);
    if (requested < minimumFloors.a + minimumFloors.b) throw insideTooSmall(state, requested, natural, minimumFloors);
    // Size both legs from `start` (converges within 5 quote rounds). Writes spendA / legs / projected as it goes.
    const sizeInside = async (start: bigint, floors: InsideFloors) => {
      spendA = start;
      for (let index = 0; index < 5; index++) {
        setJupiterRelayHint(hintKey, spendA);
        const [actualA, actualB] = await Promise.all([
          actualLeg(state.mintA, spendA), actualLeg(state.mintB, requested - spendA),
        ]);
        legs = [actualA, actualB];
        // A quotable leg whose guaranteed output still rounds to zero tokens cannot fund that side.
        if (actualA.minOut <= 0n || actualB.minOut <= 0n) throw new AmountTooSmallError();
        projected = projectedSqrt(state, legs.flatMap((item) => item.route ? [item.route] : []));
        const desired = amountsAt(state, projected, new BN("1000000000000000000"));
        const next = clampInsideSpend(requested, allocateSpend(requested, BigInt(desired.amountA.toString()), BigInt(desired.amountB.toString()),
          { spend: spendA, out: actualA.minOut }, { spend: requested - spendA, out: actualB.minOut }, 0n), floors);
        const difference = next > spendA ? next - spendA : spendA - next;
        if (difference * 1_000n <= requested * 2n) break;
        if (index === 4) throw new Error("Pool price and swap ratio did not converge, please retry later");
        spendA = next;
      }
    };
    const steps = smallLegFloorSteps(requested);
    for (let step = 0; ; step++) {
      const floors = insideFloors(state.inputMint, state.mintA, state.mintB, requested, steps[step]);
      if (requested < floors.a + floors.b) continue;
      // Fallback steps start from the pool-price split: the relay hint is an allocation sized for a larger bump.
      const useHint = step === 0 && hinted !== undefined && hinted > 0n && hinted < requested;
      const start = clampInsideSpend(requested, useHint ? hinted : natural, floors);
      // A leg raised to its floor (the small-leg bump) can be what pushes a thin pool's price too far.
      const bumped = (current: bigint) => (floors.quoteA && current <= floors.a && natural < floors.a) ||
        (floors.quoteB && requested - current <= floors.b && requested - natural < floors.b);
      try {
        await sizeInside(start, floors);
        break;
      } catch (error) {
        const minorityIsA = floors.quoteA && spendA <= floors.a;
        // A smaller fallback bump whose swap output rounds to zero cannot fund that side, and smaller ones are worse.
        if (step > 0 && error instanceof AmountTooSmallError && bumped(spendA)) throw smallLegMovesPrice(state, minorityIsA);
        if (!(error instanceof PoolPriceMoveError) || !bumped(spendA)) throw error;
        // Fall back to a smaller bump; at Jupiter's minimum there is nothing smaller to try.
        if (step === steps.length - 1) throw smallLegMovesPrice(state, minorityIsA);
      }
    }
    legs = await Promise.all(legs.map(buildLeg));
  }
  assertNativeInputFeeCoverage(deposit.inputFee, legs);
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
