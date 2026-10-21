import "@/lib/engine-host";
/**
 * Size-aware range ranking (pure, browser-safe). The per-pool payload ships the whole APR model, so the
 * candidates are re-priced for the amount the user typed without another request.
 *
 * A candidate is kept out of "Best" when the deposit does not fit the pool:
 *  - crowded: the deposit's own liquidity would be more than MAX_OWN_LIQUIDITY_SHARE of the liquidity
 *    active at the current price (L_me / (L_active + L_me));
 *  - near-edge: the nearer range edge is closer than EDGE_TO_IMPACT_MIN_MULTIPLE x the price move the
 *    deposit's rebalancing swap could cause if it traded against this pool. The swap is taken as half the
 *    deposit, as token B into the active liquidity, a worst case since routes often avoid the pool.
 * These are rough guides for ranking, not a forecast.
 */
import { sqrtPriceAtTick } from "@sofinance/engine/range-apr/tick-math";
import { liquidityForCapital } from "./clmm-liquidity";
import { estimateRangeApr } from "./range-apr";
import { toRangeAprInputs } from "./selection";
import type { PoolRangeAprPayload, SizeFit } from "./types";

export const MAX_OWN_LIQUIDITY_SHARE = 0.5;
/**
 * 3x, not 2x: live on TSLA/TSLAx (spacing 60, ~$2k TVL) a 1000 USDC deposit estimated ~25 bps of impact and
 * Standard's nearer edge sat ~50 bps away (2.0x); it passed a 2x guard yet prepare failed to converge
 * (the rebalancing swap plus own liquidity shift the ratio too far). Wide (~110 bps, 4.4x) prepared fine.
 */
export const EDGE_TO_IMPACT_MIN_MULTIPLE = 3;
/** Fraction of the deposit assumed to be swapped through the pool when estimating price impact. */
export const SWAP_SHARE_OF_DEPOSIT = 0.5;

/** Liquidity of other LPs in the bin holding the current price, or null when the window lacks it. */
export function activeLiquidity(payload: PoolRangeAprPayload): number | null {
  const { tickSpacing, tickCurrent } = payload.pool;
  const binTick = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
  const bin = payload.model.bins.find((item) => item.tick === binTick);
  return bin ? bin.liquidity : null;
}

/** Price move (bps) from swapping SWAP_SHARE_OF_DEPOSIT of `capitalUsd` as token B into the active liquidity. */
export function estimatedPoolImpactBps(payload: PoolRangeAprPayload, capitalUsd: number): number {
  const active = activeLiquidity(payload);
  const { currentSqrt, usdPerRawB } = payload.model;
  if (!(capitalUsd > 0)) return 0;
  if (!active || !(active > 0) || !(usdPerRawB > 0) || !(currentSqrt > 0)) return Number.POSITIVE_INFINITY;
  const rawB = (capitalUsd * SWAP_SHARE_OF_DEPOSIT) / usdPerRawB;
  const relativeSqrtMove = rawB / active / currentSqrt;
  return ((1 + relativeSqrtMove) ** 2 - 1) * 10_000;
}

/** Distance (bps of price) from the current price to the nearer range edge; 0 when outside the range. */
export function nearerEdgeBps(currentSqrt: number, range: { tickLower: number; tickUpper: number }): number {
  const lower = sqrtPriceAtTick(range.tickLower);
  const upper = sqrtPriceAtTick(range.tickUpper);
  if (!(currentSqrt > lower) || !(currentSqrt < upper)) return 0;
  const toLower = (currentSqrt / lower) ** 2 - 1;
  const toUpper = (upper / currentSqrt) ** 2 - 1;
  return Math.min(toLower, toUpper) * 10_000;
}

export function sizeFitFor(
  payload: PoolRangeAprPayload, range: { tickLower: number; tickUpper: number }, capitalUsd: number,
): SizeFit {
  const { currentSqrt, usdPerRawB } = payload.model;
  const active = activeLiquidity(payload) ?? 0;
  const own = liquidityForCapital(capitalUsd, currentSqrt, sqrtPriceAtTick(range.tickLower), sqrtPriceAtTick(range.tickUpper), usdPerRawB);
  const ownShare = own > 0 ? own / (active + own) : 0;
  const impactBps = estimatedPoolImpactBps(payload, capitalUsd);
  const edgeBps = nearerEdgeBps(currentSqrt, range);
  const facts = { ownSharePct: ownShare * 100, edgeBps, impactBps };
  if (ownShare > MAX_OWN_LIQUIDITY_SHARE) return { status: "excluded", reason: "crowded", ...facts };
  if (edgeBps < EDGE_TO_IMPACT_MIN_MULTIPLE * impactBps) return { status: "excluded", reason: "near-edge", ...facts };
  return { status: "ok", ...facts };
}

/**
 * The payload re-priced for `capitalUsd`: every candidate's estimate uses that capital (own liquidity is
 * already part of the fee share in `estimateRangeApr`) and carries its `sizeFit`. Without a usable amount,
 * or for a degraded payload, the server's reference-capital payload is returned unchanged.
 */
export function payloadForCapital(payload: PoolRangeAprPayload, capitalUsd: number | null | undefined): PoolRangeAprPayload {
  if (!capitalUsd || !Number.isFinite(capitalUsd) || capitalUsd <= 0 || payload.sample.degraded) return payload;
  const inputs = { ...toRangeAprInputs(payload), capitalUsd };
  return {
    ...payload,
    referenceCapitalUsd: capitalUsd,
    presets: payload.presets.map((preset) => ({
      ...preset,
      estimate: estimateRangeApr(inputs, preset),
      sizeFit: sizeFitFor(payload, preset, capitalUsd),
    })),
  };
}

/**
 * USD value of the typed amount for the selected input asset, or null when it cannot be valued (the
 * estimate then stays at the reference capital). Pool tokens are valued from the payload's own model.
 */
export function depositUsd(input: {
  amount: number | null; inputMint: string | null; inputKind: "native" | "token";
  usdcMint: string; wsolMint: string; solUsd: number | null;
  mintA: string; mintB: string; payload: PoolRangeAprPayload | null;
}): number | null {
  const { amount, inputMint, payload } = input;
  if (amount === null || !(amount > 0) || !inputMint) return null;
  if (input.inputKind === "token" && inputMint === input.usdcMint) return amount;
  if (input.inputKind === "native" || inputMint === input.wsolMint) return input.solUsd && input.solUsd > 0 ? amount * input.solUsd : null;
  if (!payload || !(payload.model.usdPerRawB > 0)) return null;
  const usdPerB = payload.model.usdPerRawB * 10 ** payload.pool.decimalsB;
  if (inputMint === input.mintB) return amount * usdPerB;
  if (inputMint === input.mintA) return payload.pool.currentPrice > 0 ? amount * payload.pool.currentPrice * usdPerB : null;
  return null;
}
