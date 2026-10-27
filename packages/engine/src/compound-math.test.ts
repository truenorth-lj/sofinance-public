import BN from "bn.js";
import { LiquidityMathUtil, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { expect, it } from "vitest";
import { accruedFee, amountsForCompoundLiquidity, conservativeSwapBalances, MAX_U64, MAX_U128,
  sizeBufferedCompoundLiquidity, sizeCompoundLiquidity } from "./compound-math";
import { DEFAULT_COMPOUND_ADD_TOLERANCE_BPS } from "./ids";

it("includes growth since the checkpoint and uses both boundary ticks", () => {
  const q = 1n << 64n;
  const base = { tickCurrent: 0, tickLower: -100, tickUpper: 100, global: 10n * q,
    lowerOutside: 2n * q, upperOutside: 3n * q, lastInside: q, liquidity: 7n, owed: 4n };
  expect(accruedFee(base)).toBe(32n);
  expect(accruedFee({ ...base, tickCurrent: 100, lastInside: q })).toBe(4n);
  expect(accruedFee({ ...base, tickCurrent: -101, lowerOutside: 4n * q, upperOutside: q, lastInside: 2n * q })).toBe(11n);
});
it("wraps u128 growth exactly and fails instead of overflowing u64 token amounts", () => {
  const base = { tickCurrent: 0, tickLower: -1, tickUpper: 1, global: 3n, lowerOutside: 0n,
    upperOutside: 0n, lastInside: MAX_U128 - 1n, liquidity: 1n << 64n, owed: 0n };
  expect(accruedFee(base)).toBe(5n);
  expect(() => accruedFee({ ...base, owed: MAX_U64 })).toThrow("u64");
});
it("sizes the largest feasible liquidity using only both harvested raw balances", () => {
  const lower = BigInt(TickUtil.getSqrtPriceAtTick(-100).toString());
  const upper = BigInt(TickUtil.getSqrtPriceAtTick(100).toString());
  const price = 1n << 64n;
  for (const [a, b] of [[1n, 1n], [123n, 991n], [1_000_000n, 3n], [3n, 1_000_000n], [0n, 100n]]) {
    const sized = sizeCompoundLiquidity(price, lower, upper, a!, b!);
    expect(sized.a <= a! && sized.b <= b!).toBe(true);
    const next = amountsForCompoundLiquidity(price, lower, upper, sized.liquidity + 1n);
    expect(next.a > a! || next.b > b!).toBe(true);
    const sdk = LiquidityMathUtil.getAmountsForLiquidity(new BN(price.toString()), new BN(lower.toString()), new BN(upper.toString()), new BN(sized.liquidity.toString()), true);
    expect(sized.a.toString()).toBe(sdk.amountA.toString());
    expect(sized.b.toString()).toBe(sdk.amountB.toString());
  }
  expect(sizeCompoundLiquidity(price, lower, upper, 0n, 100n).liquidity).toBe(0n);
});
it("caps the position u128 total and permits small yields without a profitability gate", () => {
  const q = 1n << 64n;
  const sized = sizeCompoundLiquidity(q, q / 2n, q * 2n, 1n, 1n, MAX_U128 - 1n);
  expect(sized.liquidity).toBe(1n);
  expect(() => sizeCompoundLiquidity(q, q, q, 1n, 1n)).toThrow(/invalid/i);
  expect(() => sizeCompoundLiquidity(q, q / 2n, q * 2n, MAX_U64 + 1n, 1n)).toThrow("range");
});
it("preserves the original range and uses only its required side when price is outside", () => {
  const q = 1n << 64n;
  for (const price of [q / 4n, q / 2n, q * 2n, q * 3n]) {
    const lower = q / 2n, upper = q * 2n;
    const sized = sizeCompoundLiquidity(price, lower, upper, 101n, 37n);
    expect(sized.liquidity).toBeGreaterThan(0n);
    expect(price <= lower ? sized.b : sized.a).toBe(0n);
    const next = amountsForCompoundLiquidity(price, lower, upper, sized.liquidity + 1n);
    expect(next.a > 101n || next.b > 37n).toBe(true);
    const sdk = LiquidityMathUtil.getAmountsForLiquidity(new BN(price.toString()), new BN(lower.toString()), new BN(upper.toString()), new BN(sized.liquidity.toString()), true);
    expect(sized.a.toString()).toBe(sdk.amountA.toString());
    expect(sized.b.toString()).toBe(sdk.amountB.toString());
  }
  expect(sizeCompoundLiquidity(q / 4n, q / 2n, q * 2n, 0n, 37n).liquidity).toBe(0n);
  expect(sizeCompoundLiquidity(q * 3n, q / 2n, q * 2n, 101n, 0n).liquidity).toBe(0n);
});
it("haircuts the swap-output balance to minOut before add sizing", () => {
  const mintA = "A", mintB = "B";
  expect(conservativeSwapBalances({ endingA: 1_000n, endingB: 400n, mintA, mintB,
    swap: { outputMint: mintA, quotedOutputAmount: "200", minOutputAmount: "199", simulatedOutputAmount: "200" } }))
    .toEqual({ a: 999n, b: 400n });
  expect(conservativeSwapBalances({ endingA: 1_000n, endingB: 400n, mintA, mintB, swap: null }))
    .toEqual({ a: 1_000n, b: 400n });
});
it("sizes below exact balances and keeps amountMax inside the conservative leftover budget", () => {
  const lower = BigInt(TickUtil.getSqrtPriceAtTick(-100).toString());
  const upper = BigInt(TickUtil.getSqrtPriceAtTick(100).toString());
  const price = 1n << 64n;
  const a = 2_000_000n, b = 3_000_000n;
  const full = sizeCompoundLiquidity(price, lower, upper, a, b);
  const buffered = sizeBufferedCompoundLiquidity(price, lower, upper, a, b, 0n, DEFAULT_COMPOUND_ADD_TOLERANCE_BPS);
  expect(buffered.liquidity).toBeLessThan(full.liquidity);
  expect(buffered.liquidity).toBeGreaterThan(0n);
  expect(buffered.amountMaxA).toBe(a);
  expect(buffered.amountMaxB).toBe(b);
  expect(buffered.a).toBeLessThan(a);
  expect(buffered.b).toBeLessThan(b);
  expect(buffered.a * (10_000n + BigInt(DEFAULT_COMPOUND_ADD_TOLERANCE_BPS))).toBeLessThanOrEqual(a * 10_000n + 10_000n);
  expect(buffered.b * (10_000n + BigInt(DEFAULT_COMPOUND_ADD_TOLERANCE_BPS))).toBeLessThanOrEqual(b * 10_000n + 10_000n);
  const next = amountsForCompoundLiquidity(price, lower, upper, buffered.liquidity);
  expect(next.a).toBe(buffered.a);
  expect(next.b).toBe(buffered.b);
  const onePercent = sizeBufferedCompoundLiquidity(price, lower, upper, a, b, 0n, 100);
  expect(buffered.liquidity).toBeLessThan(onePercent.liquidity);
  // Observed busy-pool drift was ~1.8% over ~70s; required+1.8% must still fit the cap.
  expect(buffered.a * 10_180n / 10_000n).toBeLessThanOrEqual(buffered.amountMaxA);
  expect(buffered.b * 10_180n / 10_000n).toBeLessThanOrEqual(buffered.amountMaxB);
});
it("keeps a one-unit add when the tolerance haircut would otherwise drop dust to zero", () => {
  const q = 1n << 64n;
  const full = sizeCompoundLiquidity(q, q / 2n, q * 2n, 1n, 1n);
  expect(full.liquidity).toBeGreaterThan(0n);
  const buffered = sizeBufferedCompoundLiquidity(q, q / 2n, q * 2n, 1n, 1n, 0n, 100);
  expect(buffered.liquidity).toBeGreaterThan(0n);
  expect(buffered.amountMaxA).toBeLessThanOrEqual(1n);
  expect(buffered.amountMaxB).toBeLessThanOrEqual(1n);
});
