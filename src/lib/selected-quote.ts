import "server-only";

import BN from "bn.js";
import { LiquidityMathUtil, SqrtPriceMath, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { DEFAULT_RESALE_FLOOR_BPS, MAX_PRICE_IMPACT_BPS, QUOTE_TTL_MS, SLIPPAGE_BPS } from "./ids";
import { meetsResaleFloor, parseResaleFloorBps, parseTokenAmount } from "./amount";
import { allocateSpend, positionSide } from "./quote-math";
import { buildRoute, type BuildRoute } from "./jupiter-route";
import { readSelectedPositionState, type PositionSelection, type SelectedPositionState } from "./selected-state";

type SwapLeg = { inputMint: string; outputMint: string; spend: bigint; minOut: bigint; route: BuildRoute | null };

function projectedSqrt(state: SelectedPositionState, routes: BuildRoute[]): BN {
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
  if (TickUtil.getTickAtSqrtPrice(price) !== state.tickCurrent) throw new Error("Swap may cross active tick, cross-tick depth estimation not currently supported");
  return price;
}

function amountsAt(state: SelectedPositionState, sqrt: BN, liquidity: BN) {
  return LiquidityMathUtil.getAmountsForLiquidity(sqrt, new BN(state.lowerSqrtX64), new BN(state.upperSqrtX64), liquidity, true);
}

async function leg(wallet: string, inputMint: string, outputMint: string, spend: bigint, nativeSource = false): Promise<SwapLeg> {
  if (spend <= 0n) throw new Error("Swap amount must be greater than zero");
  if (inputMint === outputMint) return { inputMint, outputMint, spend, minOut: spend, route: null };
  const route = await buildRoute(wallet, inputMint, outputMint, spend, nativeSource);
  return { inputMint, outputMint, spend, minOut: BigInt(route.otherAmountThreshold), route };
}

function priceImpactAgainstProbe(actual: SwapLeg, sample: SwapLeg, probe: bigint) {
  if (actual.minOut * probe * 10_000n < sample.minOut * actual.spend * BigInt(10_000 - MAX_PRICE_IMPACT_BPS)) {
    throw new Error(`Price impact relative to probe route exceeds ${MAX_PRICE_IMPACT_BPS / 100}% limit`);
  }
}

export async function getSelectedQuoteBundle(
  wallet: string, selection: PositionSelection, amount: string,
  requestedFloorBps = DEFAULT_RESALE_FLOOR_BPS,
) {
  const floorBps = parseResaleFloorBps(requestedFloorBps);
  const state = await readSelectedPositionState(wallet, selection);
  if (!state.ownsNft) throw new Error("Wallet does not have an available position NFT ATA for the selected position");
  if (state.paused || state.frozen || state.transferFee || state.unsupportedExtensions.length) {
    throw new Error(`Pool asset currently paused, account frozen, transfer fee charged, or has unsupported settings${state.unsupportedExtensions.length ? `: ${state.unsupportedExtensions.join(", ")}` : ""}`);
  }
  if (!state.sufficientSol) throw new Error("Insufficient SOL, reserve at least 0.01 SOL to pay network fees and possible ATA rent");
  const requested = parseTokenAmount(amount, state.inputDecimals);
  if (BigInt(state.inputBalance) < requested) throw new Error("Insufficient input asset balance or SOL reserve");
  const probe = requested / 10n;
  if (probe <= 0n) throw new Error("Input amount too small to obtain probe route");
  let spendA = 0n;
  let legs: SwapLeg[] = [];
  let projected = new BN(state.sqrtPriceX64);
  if (state.rangeSide !== "inside") {
    const outputMint = state.rangeSide === "below" ? state.mintA : state.mintB;
    const sample = await leg(wallet, state.inputMint, outputMint, probe, state.inputKind === "native");
    const actual = await leg(wallet, state.inputMint, outputMint, requested, state.inputKind === "native");
    priceImpactAgainstProbe(actual, sample, probe);
    legs = [actual];
    spendA = outputMint === state.mintA ? requested : 0n;
    projected = projectedSqrt(state, actual.route ? [actual.route] : []);
  } else {
    const [probeA, probeB] = await Promise.all([
      leg(wallet, state.inputMint, state.mintA, probe, state.inputKind === "native"),
      leg(wallet, state.inputMint, state.mintB, probe, state.inputKind === "native"),
    ]);
    const base = amountsAt(state, projected, new BN("1000000000000000000"));
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
      projected = projectedSqrt(state, legs.flatMap((item) => item.route ? [item.route] : []));
      const desired = amountsAt(state, projected, new BN("1000000000000000000"));
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
  const liquidity = LiquidityMathUtil.getLiquidityFromAmounts(projected,
    new BN(state.lowerSqrtX64), new BN(state.upperSqrtX64), new BN(outA.toString()), new BN(outB.toString()));
  liquidity.isubn(1);
  if (liquidity.lten(0)) throw new Error("Conservative minimum output insufficient to add valid liquidity");
  const amounts = amountsAt(state, projected, liquidity);
  const requiredA = BigInt(amounts.amountA.toString());
  const requiredB = BigInt(amounts.amountB.toString());
  if (requiredA > outA || requiredB > outB) throw new Error("amountMax exceeds conservative swap minOut");
  const resaleLegs = await Promise.all([
    requiredA > 0n ? leg(wallet, state.mintA, state.inputMint, requiredA) : null,
    requiredB > 0n ? leg(wallet, state.mintB, state.inputMint, requiredB) : null,
  ]);
  const resale = resaleLegs.reduce((sum, item) => sum + (item?.minOut || 0n), 0n);
  const timestamp = Date.now();
  const quote = {
    wallet, inputMint: state.inputMint, inputKind: state.inputKind, inputDecimals: state.inputDecimals,
    positionMint: state.positionMint, positionAccount: state.positionAccount, poolId: state.poolId,
    mintA: state.mintA, mintB: state.mintB, decimalsA: state.decimalsA, decimalsB: state.decimalsB,
    rangeSide: state.rangeSide, requested: requested.toString(), spendA: spendA.toString(),
    spendB: (requested - spendA).toString(), minOutA: outA.toString(), minOutB: outB.toString(),
    liquidity: liquidity.toString(), amountMaxA: amounts.amountA.toString(), amountMaxB: amounts.amountB.toString(),
    dustA: (outA - requiredA).toString(), dustB: (outB - requiredB).toString(),
    resaleInput: resale.toString(), minimumResaleInput: ((requested * BigInt(floorBps) + 9_999n) / 10_000n).toString(),
    roundtripCostInput: (requested > resale ? requested - resale : 0n).toString(),
    projectedPrice: TickUtil.sqrtPriceX64ToPrice(projected, state.decimalsA, state.decimalsB).toString(),
    slot: state.slot, fetchedAt: timestamp, expiresAt: timestamp + QUOTE_TTL_MS,
    passesFloor: meetsResaleFloor(requested, resale, floorBps), floorBps,
    maxImpactBps: MAX_PRICE_IMPACT_BPS, slippageBps: SLIPPAGE_BPS,
    routeTouchesTargetPool: legs.some((item) => item.route?.routePlan.some((hop) => hop.swapInfo.ammKey === state.poolId)),
  };
  return { quote, legs, state };
}

export type SelectedQuote = Awaited<ReturnType<typeof getSelectedQuoteBundle>>["quote"];
