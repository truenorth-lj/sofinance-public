import "server-only";

import BN from "bn.js";
import { LiquidityMathUtil, SqrtPriceMath, TickUtil } from "@raydium-io/raydium-sdk-v2";
import {
  DEFAULT_ADD_TOLERANCE_BPS, DEFAULT_RESALE_FLOOR_BPS, MAX_PRICE_IMPACT_BPS, MIN_SOL_LAMPORTS,
  QUOTE_TTL_MS, SLIPPAGE_BPS,
} from "./ids";
import { meetsResaleFloor, parseAddToleranceBps, parseResaleFloorBps, parseTokenAmount } from "./amount";
import { allocateSpend, padAmountMax, positionSide, toleranceLiquidity } from "./quote-math";
import { buildRoute, type BuildRoute } from "./jupiter-route";
import { estimateOpenPositionRent } from "./open-rent";
import { resolveOpenRange, type OpenRangeInput } from "./open-range";
import { rpcConnection } from "./rpc";
import { readOpenPoolState, type OpenPoolState, type OpenPositionSelection } from "./open-state";
import type { OpenPositionQuote } from "./open-types";
import type { ResolvedOpenRange } from "./open-range";

export type OpenSwapLeg = {
  inputMint: string;
  outputMint: string;
  spend: bigint;
  minOut: bigint;
  route: BuildRoute | null;
};

export type OpenQuoteBundle = {
  quote: OpenPositionQuote;
  legs: OpenSwapLeg[];
  state: OpenPoolState;
  range: ResolvedOpenRange;
};

function projectedSqrt(
  state: OpenPoolState, lowerSqrtX64: string, upperSqrtX64: string,
  rangeSide: "below" | "inside" | "above", routes: BuildRoute[],
): BN {
  let price = new BN(state.sqrtPriceX64);
  const liquidity = new BN(state.poolLiquidity);
  let targetHops = 0;
  for (const route of routes) for (const leg of route.routePlan) {
    if (leg.swapInfo.ammKey !== state.poolId) continue;
    targetHops++;
    if (targetHops > 1 || leg.bps !== 10_000) {
      throw new Error("Target pool route too complex, cannot conservatively estimate pre-open price");
    }
    const zeroForOne = leg.swapInfo.inputMint === state.mintA && leg.swapInfo.outputMint === state.mintB;
    const oneForZero = leg.swapInfo.inputMint === state.mintB && leg.swapInfo.outputMint === state.mintA;
    if (!zeroForOne && !oneForZero) throw new Error("Target pool route asset mismatch");
    price = SqrtPriceMath.getNextSqrtPriceFromInput(price, liquidity, new BN(leg.swapInfo.inAmount), zeroForOne);
  }
  if (positionSide(BigInt(price.toString()), BigInt(lowerSqrtX64), BigInt(upperSqrtX64)) !== rangeSide) {
    throw new Error("Swap may cause target pool price to cross the selected range, please re-quote");
  }
  if (TickUtil.getTickAtSqrtPrice(price) !== state.tickCurrent) {
    throw new Error("Swap may cross active tick, cross-tick depth estimation not currently supported");
  }
  return price;
}

function amountsAt(sqrt: BN, lowerSqrtX64: string, upperSqrtX64: string, liquidity: BN) {
  return LiquidityMathUtil.getAmountsForLiquidity(sqrt, new BN(lowerSqrtX64), new BN(upperSqrtX64), liquidity, true);
}

async function leg(wallet: string, inputMint: string, outputMint: string, spend: bigint, nativeSource = false): Promise<OpenSwapLeg> {
  if (spend <= 0n) throw new Error("Swap amount must be greater than zero");
  if (inputMint === outputMint) return { inputMint, outputMint, spend, minOut: spend, route: null };
  const route = await buildRoute(wallet, inputMint, outputMint, spend, nativeSource);
  return { inputMint, outputMint, spend, minOut: BigInt(route.otherAmountThreshold), route };
}

function priceImpactAgainstProbe(actual: OpenSwapLeg, sample: OpenSwapLeg, probe: bigint) {
  if (actual.minOut * probe * 10_000n < sample.minOut * actual.spend * BigInt(10_000 - MAX_PRICE_IMPACT_BPS)) {
    throw new Error(`Price impact relative to probe route exceeds ${MAX_PRICE_IMPACT_BPS / 100}% limit`);
  }
}

export async function getOpenPositionQuoteBundle(
  wallet: string,
  selection: OpenPositionSelection,
  amount: string,
  range: OpenRangeInput,
  requestedFloorBps = DEFAULT_RESALE_FLOOR_BPS,
  requestedToleranceBps = DEFAULT_ADD_TOLERANCE_BPS,
): Promise<OpenQuoteBundle> {
  const floorBps = parseResaleFloorBps(requestedFloorBps);
  const toleranceBps = parseAddToleranceBps(requestedToleranceBps);
  const state = await readOpenPoolState(wallet, selection);
  if (state.paused || state.frozen || state.transferFee || state.unsupportedExtensions.length) {
    const extras = state.unsupportedExtensions.length ? `: ${state.unsupportedExtensions.join(", ")}` : "";
    throw new Error(`Pool asset currently paused, account frozen, transfer fee charged, or has unsupported settings${extras}`);
  }
  if (!state.sufficientSol) {
    throw new Error("Insufficient SOL, reserve at least 0.01 SOL to pay network fees and position rent");
  }
  const resolved = resolveOpenRange({
    range,
    currentPrice: Number(state.price),
    tickCurrent: state.tickCurrent,
    sqrtPriceX64: state.sqrtPriceX64,
    decimalsA: state.decimalsA,
    decimalsB: state.decimalsB,
    tickSpacing: state.tickSpacing,
  });
  const lowerSqrtX64 = TickUtil.getSqrtPriceAtTick(resolved.tickLower).toString();
  const upperSqrtX64 = TickUtil.getSqrtPriceAtTick(resolved.tickUpper).toString();
  const requested = parseTokenAmount(amount, state.inputDecimals);
  if (BigInt(state.inputBalance) < requested) {
    throw new Error("Insufficient input asset balance or SOL reserve");
  }
  const probe = requested / 10n;
  if (probe <= 0n) throw new Error("Input amount too small to obtain probe route");
  let spendA = 0n;
  let legs: OpenSwapLeg[] = [];
  let projected = new BN(state.sqrtPriceX64);
  if (resolved.rangeSide !== "inside") {
    const outputMint = resolved.rangeSide === "below" ? state.mintA : state.mintB;
    const sample = await leg(wallet, state.inputMint, outputMint, probe, state.inputKind === "native");
    const actual = await leg(wallet, state.inputMint, outputMint, requested, state.inputKind === "native");
    priceImpactAgainstProbe(actual, sample, probe);
    legs = [actual];
    spendA = outputMint === state.mintA ? requested : 0n;
    projected = projectedSqrt(state, lowerSqrtX64, upperSqrtX64, resolved.rangeSide, actual.route ? [actual.route] : []);
  } else {
    const [probeA, probeB] = await Promise.all([
      leg(wallet, state.inputMint, state.mintA, probe, state.inputKind === "native"),
      leg(wallet, state.inputMint, state.mintB, probe, state.inputKind === "native"),
    ]);
    const base = amountsAt(projected, lowerSqrtX64, upperSqrtX64, new BN("1000000000000000000"));
    spendA = allocateSpend(requested, BigInt(base.amountA.toString()), BigInt(base.amountB.toString()),
      { spend: probe, out: probeA.minOut }, { spend: probe, out: probeB.minOut }, 1n);
    for (let index = 0; index < 5; index++) {
      const [actualA, actualB] = await Promise.all([
        leg(wallet, state.inputMint, state.mintA, spendA, state.inputKind === "native"),
        leg(wallet, state.inputMint, state.mintB, requested - spendA, state.inputKind === "native"),
      ]);
      legs = [actualA, actualB];
      priceImpactAgainstProbe(actualA, probeA, probe);
      priceImpactAgainstProbe(actualB, probeB, probe);
      projected = projectedSqrt(state, lowerSqrtX64, upperSqrtX64, resolved.rangeSide,
        legs.flatMap((item) => item.route ? [item.route] : []));
      const desired = amountsAt(projected, lowerSqrtX64, upperSqrtX64, new BN("1000000000000000000"));
      const next = allocateSpend(requested, BigInt(desired.amountA.toString()), BigInt(desired.amountB.toString()),
        { spend: spendA, out: actualA.minOut }, { spend: requested - spendA, out: actualB.minOut }, 1n);
      const difference = next > spendA ? next - spendA : spendA - next;
      if (difference * 1_000n <= requested * 2n) break;
      if (index === 4) throw new Error("Pool price and swap ratio did not converge, please retry later");
      spendA = next;
    }
  }
  const outA = legs.find((item) => item.outputMint === state.mintA)?.minOut || 0n;
  const outB = legs.find((item) => item.outputMint === state.mintB)?.minOut || 0n;
  const fullLiquidity = LiquidityMathUtil.getLiquidityFromAmounts(projected,
    new BN(lowerSqrtX64), new BN(upperSqrtX64), new BN(outA.toString()), new BN(outB.toString()));
  fullLiquidity.isubn(1);
  const liquidity = new BN(toleranceLiquidity(BigInt(fullLiquidity.toString()), toleranceBps).toString());
  if (liquidity.lten(0)) throw new Error("Conservative minimum output insufficient to open a valid position");
  const amounts = amountsAt(projected, lowerSqrtX64, upperSqrtX64, liquidity);
  const requiredA = BigInt(amounts.amountA.toString());
  const requiredB = BigInt(amounts.amountB.toString());
  if (requiredA > outA || requiredB > outB) throw new Error("amountMax exceeds conservative swap minOut");
  const amountMaxA = padAmountMax(requiredA, outA, toleranceBps);
  const amountMaxB = padAmountMax(requiredB, outB, toleranceBps);
  const resaleLegs = await Promise.all([
    outA > 0n ? leg(wallet, state.mintA, state.inputMint, outA) : null,
    outB > 0n ? leg(wallet, state.mintB, state.inputMint, outB) : null,
  ]);
  const resale = resaleLegs.reduce((sum, item) => sum + (item?.minOut || 0n), 0n);
  const rent = await estimateOpenPositionRent({
    connection: rpcConnection(),
    programId: state.programId,
    poolId: state.poolId,
    tickLower: resolved.tickLower,
    tickUpper: resolved.tickUpper,
    tickSpacing: state.tickSpacing,
  });
  const networkFeeLamportsEstimate = 50_000n;
  const rentTotal = rent.refundableLamports + rent.nonRefundableLamports;
  const nativeSpend = state.inputKind === "native" ? requested : 0n;
  const requiredSol = BigInt(MIN_SOL_LAMPORTS) + rentTotal + networkFeeLamportsEstimate + nativeSpend;
  const sufficientSol = BigInt(state.solLamports) >= requiredSol;
  const warnings: string[] = [];
  if (resolved.warning) warnings.push(resolved.warning);
  if (!resolved.inRange) {
    warnings.push("Selected range is out of the current pool price; the position will be single-sided and will not earn fees until price re-enters.");
  }
  if (rent.tickArrayInitRequired) {
    const sol = Number(rent.tickArrayLamports) / 1e9;
    warnings.push(`This range initializes tick array(s), costing about ${sol.toFixed(4)} SOL that is not refunded when you close the position.`);
  }
  if (rent.protocolPositionInitRequired) {
    warnings.push("This tick range has no protocol position yet; opening pays extra one-time rent that is not returned to you.");
  }
  if (state.token2022A || state.token2022B) {
    warnings.push("One or both pool tokens use Token-2022. Transfer-fee and freeze extensions are blocked when currently active; freeze authority may still exist.");
  }
  if (state.freezeRisk) {
    warnings.push("A pool mint has a freeze authority. The issuer could freeze accounts later.");
  }
  if (!sufficientSol) {
    throw new Error(
      rent.tickArrayInitRequired
        ? `Unfunded tick array(s) for this range would cost extra SOL (not refunded on close). Need at least ${(Number(requiredSol) / 1e9).toFixed(4)} SOL including 0.01 SOL reserve, position NFT rent, and network fees.`
        : `Insufficient SOL for position NFT rent, network fees, and the 0.01 SOL reserve. Need at least ${(Number(requiredSol) / 1e9).toFixed(4)} SOL.`,
    );
  }
  const timestamp = Date.now();
  const quote: OpenPositionQuote = {
    wallet, poolId: state.poolId, inputMint: state.inputMint, inputKind: state.inputKind,
    inputDecimals: state.inputDecimals, mintA: state.mintA, mintB: state.mintB,
    symbolA: null, symbolB: null, decimalsA: state.decimalsA, decimalsB: state.decimalsB,
    feeTierBps: null, tickSpacing: state.tickSpacing, tickCurrent: state.tickCurrent,
    tickLower: resolved.tickLower, tickUpper: resolved.tickUpper,
    priceLower: resolved.priceLower, priceUpper: resolved.priceUpper,
    currentPrice: state.price,
    projectedPrice: TickUtil.sqrtPriceX64ToPrice(projected, state.decimalsA, state.decimalsB).toString(),
    rangePreset: resolved.preset, rangeSide: resolved.rangeSide, inRange: resolved.inRange,
    narrowRange: resolved.narrow, rangeWarning: resolved.warning,
    requested: requested.toString(), spendA: spendA.toString(),
    spendB: (requested - spendA).toString(), minOutA: outA.toString(), minOutB: outB.toString(),
    liquidity: liquidity.toString(), amountMaxA: amountMaxA.toString(), amountMaxB: amountMaxB.toString(),
    requiredA: requiredA.toString(), requiredB: requiredB.toString(), toleranceBps,
    dustA: (outA - requiredA).toString(), dustB: (outB - requiredB).toString(),
    resaleInput: resale.toString(),
    minimumResaleInput: ((requested * BigInt(floorBps) + 9_999n) / 10_000n).toString(),
    roundtripCostInput: (requested > resale ? requested - resale : 0n).toString(),
    passesFloor: meetsResaleFloor(requested, resale, floorBps), floorBps,
    maxImpactBps: MAX_PRICE_IMPACT_BPS, slippageBps: SLIPPAGE_BPS,
    routeTouchesTargetPool: legs.some((item) => item.route?.routePlan.some((hop) => hop.swapInfo.ammKey === state.poolId)),
    token2022A: state.token2022A, token2022B: state.token2022B,
    freezeRiskA: state.freezeRiskA, freezeRiskB: state.freezeRiskB, freezeRisk: state.freezeRisk,
    transferFee: state.transferFee, paused: state.paused, frozen: state.frozen,
    unsupportedExtensions: state.unsupportedExtensions,
    rent: {
      refundableLamports: rent.refundableLamports.toString(),
      nonRefundableLamports: rent.nonRefundableLamports.toString(),
      positionNftLamports: rent.positionNftLamports.toString(),
      nftAtaLamports: rent.nftAtaLamports.toString(),
      personalPositionLamports: rent.personalPositionLamports.toString(),
      tickArrayLamports: rent.tickArrayLamports.toString(),
      protocolPositionLamports: rent.protocolPositionLamports.toString(),
      tickArrayInitRequired: rent.tickArrayInitRequired,
      protocolPositionInitRequired: rent.protocolPositionInitRequired,
      tickArrayAccounts: rent.tickArrayAccounts,
    },
    networkFeeLamportsEstimate: networkFeeLamportsEstimate.toString(),
    requiredSolLamports: requiredSol.toString(),
    solLamports: state.solLamports.toString(),
    sufficientSol, sufficientInput: true,
    warnings, slot: state.slot, fetchedAt: timestamp, expiresAt: timestamp + QUOTE_TTL_MS,
  };
  return { quote, legs, state, range: resolved };
}
