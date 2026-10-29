import { describe, expect, it } from "vitest";
import {
  EXECUTE_DEADLINE_SECONDS, GAS_BUFFER_BPS, MAX_REQUOTE_RETRIES, MIN_RANGE_WIDTH_TICKS, OPEN_FEE_BPS, PERMIT_EXPIRATION_SECONDS,
  PERMIT_SIG_DEADLINE_SECONDS, PRICE_TOL_FLOOR_BPS, PRICE_TOL_HALFWIDTH_PCT, REQUOTE_CONFIRM_MESSAGE, SLIPPAGE_BPS,
  PINNED_UNIVERSAL_ROUTER,
} from "./open-constants";
import { assertOpenRange, defaultPriceTolBps, OpenPlanError, type OpenPoolState, planOpenAmounts, type QuoteFn, solveSplit, walkSqrtPriceAfter } from "./open-quote";
import { amountsForLiquidity, Q96, sqrtPriceAtTick } from "./tick-math";

const E18 = 10n ** 18n;
const L1 = 50_000n * E18, L2 = 200_000n * E18;
// Two stacked positions: [-20, 20] with L2 and [-5, 5] with L1; price at tick 0.
const state: OpenPoolState = {
  sqrtPriceX96: Q96, tick: 0, liquidity: L1 + L2,
  liquidityNet: new Map([[-20, L2], [-5, L1], [5, -L1], [20, -L2]]),
  scannedTicks: { lower: -1000, upper: 1000 },
};
// Fee-ish quoter at price ≈ 1 (5 bps haircut), enough for planning tests.
const quote: QuoteFn = async a => ({ ok: true, amountOut: a * 9995n / 10_000n });
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", e => (e instanceof OpenPlanError ? e.code : Promise.reject(e)));

describe("open constants (design §3.10, PM decisions 2026-10-29)", () => {
  it("are pinned", () => {
    expect({ OPEN_FEE_BPS, SLIPPAGE_BPS, PRICE_TOL_FLOOR_BPS, PRICE_TOL_HALFWIDTH_PCT, MIN_RANGE_WIDTH_TICKS, MAX_REQUOTE_RETRIES, GAS_BUFFER_BPS,
      PERMIT_EXPIRATION_SECONDS, PERMIT_SIG_DEADLINE_SECONDS, EXECUTE_DEADLINE_SECONDS })
      .toEqual({ OPEN_FEE_BPS: 10n, SLIPPAGE_BPS: 5n, PRICE_TOL_FLOOR_BPS: 0.2, PRICE_TOL_HALFWIDTH_PCT: 1, MIN_RANGE_WIDTH_TICKS: 20, MAX_REQUOTE_RETRIES: 1,
        GAS_BUFFER_BPS: 2500n, PERMIT_EXPIRATION_SECONDS: 1800, PERMIT_SIG_DEADLINE_SECONDS: 600, EXECUTE_DEADLINE_SECONDS: 600 });
    expect(PINNED_UNIVERSAL_ROUTER.address).toBe("0x204FAca1764B154221e35c0d20aBb3c525710498");
    expect(REQUOTE_CONFIRM_MESSAGE).toEqual({ zh: "價格剛變動，已重新報價，請再確認一次", en: "Price just moved. We re-quoted it, please confirm once more." });
  });
});

describe("assertOpenRange", () => {
  it("rejects ranges narrower than ±10 ticks with a clear message", () => {
    expect(() => assertOpenRange(-9, 10, 1)).toThrow("Range too narrow: width 19 ticks; minimum is ±10 ticks (width ≥ 20)");
    expect(() => assertOpenRange(-10, 10, 1)).not.toThrow();
    expect(() => assertOpenRange(0, 20, 1)).not.toThrow();
  });
  it("rejects inverted, off-spacing and out-of-bounds ranges", () => {
    for (const [l, u, s] of [[10, -10, 1], [0, 0, 1], [-15, 15, 10], [-900_000, 0, 1]] as const)
      expect(() => assertOpenRange(l, u, s)).toThrow(OpenPlanError);
  });
});

describe("defaultPriceTolBps = max(0.2 bps, 1% of half-width)", () => {
  it("floors at 0.2 bps for ±10 ticks and scales for wide ranges", () => {
    expect(defaultPriceTolBps(-10, 10)).toBe(0.2); // 1% of ~10 bps = 0.1 → floor
    expect(defaultPriceTolBps(-100, 100)).toBeCloseTo(1.005, 3);
    expect(defaultPriceTolBps(-500, 500)).toBeCloseTo(5.127, 2);
  });
});

describe("walkSqrtPriceAfter (tick walk)", () => {
  it("stays inside the active tick for small output", () => {
    const r = walkSqrtPriceAfter(state, 1n * E18, true);
    expect(r.ticksCrossed).toEqual([]);
    expect(r.sqrtPriceX96! < Q96 && r.sqrtPriceX96! > sqrtPriceAtTick(-5)).toBe(true);
  });
  it("crosses initialised ticks and drops their liquidity, both directions", () => {
    const capDown = (L1 + L2) * (Q96 - sqrtPriceAtTick(-5)) / Q96;
    const down = walkSqrtPriceAfter(state, capDown + 10n * E18, true);
    expect(down.ticksCrossed).toEqual([-5]);
    expect(down.sqrtPriceX96! < sqrtPriceAtTick(-5)).toBe(true);
    const up = walkSqrtPriceAfter(state, capDown + 10n * E18, false);
    expect(up.ticksCrossed).toEqual([5]);
  });
  it("returns null when liquidity runs out or the walk leaves the scanned window (depth guard)", () => {
    expect(walkSqrtPriceAfter(state, 10_000_000n * E18, true).sqrtPriceX96).toBeNull();
    const narrow = { ...state, liquidityNet: new Map<number, bigint>(), scannedTicks: { lower: -2, upper: 2 } };
    expect(walkSqrtPriceAfter(narrow, 1_000n * E18, true).sqrtPriceX96).toBeNull();
  });
});

describe("planOpenAmounts", () => {
  it("splits a token0 deposit so the remainder plus net swap output fit the range", async () => {
    const a = await planOpenAmounts({ state, quote, depositIsToken0: true, amountIn: 100n * E18, tickLower: -11, tickUpper: 9, tickSpacing: 1 });
    expect(a.kind).toBe("swap");
    expect(a.fee).toBe(a.quoteOut * 10n / 10_000n);
    expect(a.minOut).toBe(a.quoteOut * 9_995n / 10_000n);
    expect(a.amount0Max + a.swapIn).toBe(100n * E18);
    const need = amountsForLiquidity(a.liquidity, a.sqrtPriceAfterX96, sqrtPriceAtTick(-11), sqrtPriceAtTick(9));
    expect(need.amount0 <= a.amount0Max && need.amount1 <= a.amount1Max).toBe(true);
    // Refund (to the user) stays bounded: at ±10 ticks the 0.2 bps price tolerance costs ~2.5% of L by design.
    expect(Number(a.amount0Max - need.amount0) / 1e18).toBeLessThan(3);
  });
  it("handles a token1 deposit", async () => {
    const a = await planOpenAmounts({ state, quote, depositIsToken0: false, amountIn: 100n * E18, tickLower: -11, tickUpper: 9, tickSpacing: 1 });
    expect(a).toMatchObject({ kind: "swap", zeroForOne: false });
    expect(a.amount1Max + a.swapIn).toBe(100n * E18);
  });
  it("one-sided range: no swap and no fee; wrong token rejected", async () => {
    const a = await planOpenAmounts({ state, quote, depositIsToken0: true, amountIn: 5n * E18, tickLower: 5, tickUpper: 30, tickSpacing: 1 });
    expect(a).toMatchObject({ kind: "no-swap", fee: 0n, swapIn: 0n, amount0Max: 5n * E18, amount1Max: 0n });
    expect(await codeOf(planOpenAmounts({ state, quote, depositIsToken0: false, amountIn: 5n * E18, tickLower: 5, tickUpper: 30, tickSpacing: 1 }))).toBe("range-wrong-side");
  });
  it("rejects narrow ranges, zero amounts and pool-depth failures", async () => {
    const base = { state, quote, depositIsToken0: true, amountIn: 5n * E18, tickLower: -5, tickUpper: 5, tickSpacing: 1 };
    expect(await codeOf(planOpenAmounts(base))).toBe("range-too-narrow");
    expect(await codeOf(planOpenAmounts({ ...base, tickLower: -11, tickUpper: 9, amountIn: 0n }))).toBe("amount-invalid");
    const depth: QuoteFn = async () => ({ ok: false, reason: "pool-depth" });
    expect(await codeOf(planOpenAmounts({ ...base, tickLower: -11, tickUpper: 9, quote: depth }))).toBe("pool-depth");
    expect(await codeOf(planOpenAmounts({ ...base, tickLower: -11, tickUpper: 9, amountIn: 10_000_000n * E18 }))).toBe("pool-depth");
  });
  it("solveSplit never returns a split whose post-swap price leaves the range", async () => {
    const thin = { ...state, liquidity: 2_000n * E18, liquidityNet: new Map([[-1000, 2_000n * E18], [1000, -2_000n * E18]]) };
    expect(await codeOf(solveSplit(thin, quote, 10n * E18, -11, 9, true))).toBe("split-not-found");
    const ok = await solveSplit(thin, quote, 1n * E18 / 10n, -11, 9, true);
    expect(ok.sqrtPriceAfterX96 > sqrtPriceAtTick(-11) && ok.sqrtPriceAfterX96 < sqrtPriceAtTick(9)).toBe(true);
  });
});
