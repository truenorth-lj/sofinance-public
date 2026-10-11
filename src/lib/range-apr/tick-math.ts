/**
 * Client-safe CLMM tick helpers (no Raydium SDK, no I/O).
 *
 * Raydium CLMM follows Uniswap v3: price(tick) = 1.0001^tick for RAW token units
 * (raw B per raw A), so sqrtPrice(tick) = 1.0001^(tick / 2). The UI price is "B per 1 A":
 * ui = raw * 10^(decimalsA - decimalsB).
 *
 * Vocabulary used across `range-apr/`:
 *  - tick:  a price step of 0.01% (raw price). Only multiples of the pool's `tickSpacing` can be
 *           position boundaries.
 *  - bin:   the interval [k * tickSpacing, (k + 1) * tickSpacing) between two adjacent valid
 *           boundaries. Pool liquidity is constant inside a bin, so bins are the exact unit for fee maths.
 */
import Decimal from "decimal.js";

const D = Decimal.clone({ precision: 40 });
const LN_TICK_BASE = new D("1.0001").ln();
const Q64 = new D(2).pow(64);

export const MIN_TICK = -443636;
export const MAX_TICK = 443636;

function assertSpacing(tickSpacing: number): void {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error("Invalid pool tick spacing");
}

/** Largest multiple of `tickSpacing` that is <= `tick` (correct for negative ticks). */
export function floorToSpacing(tick: number, tickSpacing: number): number {
  assertSpacing(tickSpacing);
  return Math.floor(tick / tickSpacing) * tickSpacing + 0; // + 0 normalises -0
}

/** Smallest multiple of `tickSpacing` that is >= `tick`. */
export function ceilToSpacing(tick: number, tickSpacing: number): number {
  assertSpacing(tickSpacing);
  return Math.ceil(tick / tickSpacing) * tickSpacing + 0;
}

/** Index of the bin that contains `tick`: floor(tick / tickSpacing). */
export function binIndexOfTick(tick: number, tickSpacing: number): number {
  assertSpacing(tickSpacing);
  return Math.floor(tick / tickSpacing);
}

/** Lowest / highest tick usable as a position boundary for this spacing. */
export function usableTickBounds(tickSpacing: number): { min: number; max: number } {
  return { min: ceilToSpacing(MIN_TICK, tickSpacing), max: floorToSpacing(MAX_TICK, tickSpacing) };
}

/** sqrt(raw price) at a tick, as a float: 1.0001^(tick / 2). */
export function sqrtPriceAtTick(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/** sqrtPriceX64 (Q64.64 integer string) to a float sqrt(raw price). */
export function sqrtPriceX64ToNumber(sqrtPriceX64: string | bigint): number {
  return new D(sqrtPriceX64.toString()).div(Q64).toNumber();
}

/** Fractional tick of a pool price: 2 * ln(sqrtPrice) / ln(1.0001). Exact `tickCurrent` is its floor. */
export function exactTickFromSqrtPriceX64(sqrtPriceX64: string | bigint): number {
  const sqrt = new D(sqrtPriceX64.toString()).div(Q64);
  if (!sqrt.gt(0)) throw new Error("sqrtPriceX64 must be positive");
  return sqrt.ln().mul(2).div(LN_TICK_BASE).toNumber();
}

/** UI price (B per 1 A) to a fractional tick. */
export function exactTickFromUiPrice(price: number, decimalsA: number, decimalsB: number): number {
  if (!Number.isFinite(price) || price <= 0) throw new Error("Price must be a positive B-per-A value");
  const raw = new D(price).mul(new D(10).pow(decimalsB - decimalsA));
  return raw.ln().div(LN_TICK_BASE).toNumber();
}

/** Tick boundary to UI price (B per 1 A). */
export function uiPriceFromTick(tick: number, decimalsA: number, decimalsB: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimalsA - decimalsB);
}
