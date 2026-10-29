import {
  MIN_RANGE_HALF_WIDTH_TICKS, MIN_RANGE_WIDTH_TICKS, OPEN_FEE_BPS, PRICE_TOL_FLOOR_BPS, PRICE_TOL_HALFWIDTH_PCT, SLIPPAGE_BPS,
} from "./open-constants";
import { liquidityFromAmount0, liquidityFromAmount1, MAX_TICK, MIN_TICK, Q96, sqrtPriceAtTick } from "./tick-math";

/**
 * Open-position planner (design.md v2.2 §3.10; ported from sim_v2.py `walk_sqrt_after` / `solve_split2` /
 * `plan_open`, integer math only). Pure: pool state and a Quoter function are injected.
 */

/** Pool state read at `latest`: slot0, active liquidity and every initialised tick's liquidityNet in the scan window. */
export type OpenPoolState = {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** tick → liquidityNet for initialised ticks within ±TICK_SCAN_WORDS words of the current word. */
  liquidityNet: ReadonlyMap<number, bigint>;
  /** Inclusive tick bounds actually scanned: the walk refuses to go past them (depth unknown there). */
  scannedTicks: { lower: number; upper: number };
};

/** Quoter `amountOut` for an exact-input single swap, or a typed failure (NotEnoughLiquidity → pool depth). */
export type QuoteResult = { ok: true; amountOut: bigint } | { ok: false; reason: "pool-depth" | "quote-failed"; detail?: string };
export type QuoteFn = (amountIn: bigint, zeroForOne: boolean) => Promise<QuoteResult>;

export type OpenPlanErrorCode =
  | "range-invalid" | "range-too-narrow" | "range-wrong-side" | "amount-invalid" | "pool-depth" | "quote-failed" | "split-not-found";

export class OpenPlanError extends Error {
  constructor(readonly code: OpenPlanErrorCode, message: string) {
    super(message);
    this.name = "OpenPlanError";
  }
}

/**
 * Range checks shared by the planner and the plan checker. PM decision 2026-10-29: ranges narrower than
 * ±10 ticks (tickUpper − tickLower < 20) are rejected.
 */
export function assertOpenRange(tickLower: number, tickUpper: number, tickSpacing: number): void {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower < MIN_TICK || tickUpper > MAX_TICK || tickLower >= tickUpper)
    throw new OpenPlanError("range-invalid", `Invalid range [${tickLower}, ${tickUpper}]`);
  if (tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0)
    throw new OpenPlanError("range-invalid", `Range ticks must be multiples of tickSpacing ${tickSpacing}`);
  if (tickUpper - tickLower < MIN_RANGE_WIDTH_TICKS)
    throw new OpenPlanError("range-too-narrow",
      `Range too narrow: width ${tickUpper - tickLower} ticks; minimum is ±${MIN_RANGE_HALF_WIDTH_TICKS} ticks (width ≥ ${MIN_RANGE_WIDTH_TICKS})`);
}

/** priceTol (bps) = max(0.2, 1% of the range half-width in price bps). PM decision 2026-10-29. */
export function defaultPriceTolBps(tickLower: number, tickUpper: number): number {
  const halfWidth = Math.floor((tickUpper - tickLower) / 2);
  const halfWidthBps = (1.0001 ** halfWidth - 1) * 10_000;
  return Math.max(PRICE_TOL_FLOOR_BPS, halfWidthBps * PRICE_TOL_HALFWIDTH_PCT / 100);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
export const feeOf = (amountOut: bigint) => amountOut * OPEN_FEE_BPS / 10_000n;

/**
 * Exact post-swap sqrtPrice from the swap OUTPUT, walking initialised ticks (independent of the hook's dynamic
 * fee, which is charged on the input). `null` sqrt = liquidity runs out or the walk leaves the scanned window.
 */
export function walkSqrtPriceAfter(state: OpenPoolState, amountOut: bigint, zeroForOne: boolean): { sqrtPriceX96: bigint | null; ticksCrossed: number[] } {
  let sp = state.sqrtPriceX96, tick = state.tick, L = state.liquidity, rem = amountOut;
  const crossed: number[] = [];
  const ticks = [...state.liquidityNet.keys()].sort((a, b) => a - b);
  for (let guard = 0; guard <= ticks.length + 1; guard++) {
    if (L <= 0n) return { sqrtPriceX96: null, ticksCrossed: crossed };
    if (zeroForOne) { // price down, output token1: amount1 = L·ΔsqrtP / Q96
      const next = [...ticks].reverse().find(t => t <= tick);
      const boundary = next ?? state.scannedTicks.lower;
      const spt = sqrtPriceAtTick(Math.max(boundary, MIN_TICK));
      const cap = sp > spt ? L * (sp - spt) / Q96 : 0n;
      if (rem <= cap) return { sqrtPriceX96: sp - ceilDiv(rem * Q96, L), ticksCrossed: crossed };
      if (next === undefined) return { sqrtPriceX96: null, ticksCrossed: crossed };
      rem -= cap; sp = spt; L -= state.liquidityNet.get(next)!; crossed.push(next); tick = next - 1;
    } else { // price up, output token0: amount0 = L·Q96·(sqrtP_t − sqrtP) / (sqrtP_t·sqrtP)
      const next = ticks.find(t => t > tick);
      const boundary = next ?? state.scannedTicks.upper;
      const spt = sqrtPriceAtTick(Math.min(boundary, MAX_TICK));
      const cap = spt > sp ? L * Q96 * (spt - sp) / (spt * sp) : 0n;
      if (rem <= cap) {
        if (L * Q96 <= rem * sp) return { sqrtPriceX96: null, ticksCrossed: crossed };
        return { sqrtPriceX96: ceilDiv(L * Q96 * sp, L * Q96 - rem * sp), ticksCrossed: crossed };
      }
      if (next === undefined) return { sqrtPriceX96: null, ticksCrossed: crossed };
      rem -= cap; sp = spt; L += state.liquidityNet.get(next)!; crossed.push(next); tick = next;
    }
  }
  return { sqrtPriceX96: null, ticksCrossed: crossed };
}

/** a1/a0 demand ratio per unit L at sqrtP inside [sqrtLower, sqrtUpper], as a fraction n/d. */
function demandRatio(sp: bigint, spl: bigint, spu: bigint): { n: bigint; d: bigint } {
  return { n: (sp - spl) * sp * spu, d: (spu - sp) * Q96 * Q96 };
}

export type SwapSplit = { swapIn: bigint; amountOut: bigint; sqrtPriceAfterX96: bigint; ticksCrossed: number[]; iterations: number };

/** Quoter-driven split for a one-sided deposit into an in-range position (both directions). */
export async function solveSplit(state: OpenPoolState, quote: QuoteFn, amountIn: bigint, tickLower: number, tickUpper: number, zeroForOne: boolean, maxIterations = 8): Promise<SwapSplit> {
  const spl = sqrtPriceAtTick(tickLower), spu = sqrtPriceAtTick(tickUpper);
  let s = amountIn / 2n, iterations = 0;
  const quoteOrThrow = async (x: bigint) => {
    const q = await quote(x, zeroForOne);
    if (!q.ok) throw new OpenPlanError(q.reason, q.reason === "pool-depth" ? "Amount exceeds pool depth (NotEnoughLiquidity)" : `Quote failed${q.detail ? `: ${q.detail}` : ""}`);
    return q.amountOut;
  };
  for (; iterations <= maxIterations; iterations++) {
    if (s <= 0n) throw new OpenPlanError("split-not-found", "No swap amount keeps the post-swap price inside the range");
    const out = await quoteOrThrow(s);
    const { sqrtPriceX96: spa } = walkSqrtPriceAfter(state, out, zeroForOne);
    if (spa === null) throw new OpenPlanError("pool-depth", "Swap would exhaust the liquidity known around the current price");
    if (!(spl < spa && spa < spu)) { s = s * 3n / 4n; continue; }
    const net = out - feeOf(out);
    if (net <= 0n) throw new OpenPlanError("amount-invalid", "Amount too small to swap");
    const { n, d } = demandRatio(spa, spl, spu);
    const next = zeroForOne ? n * amountIn * s / (net * d + n * s) : amountIn * d * s / (d * s + n * net);
    const tol = s / 100_000_000n > 1n ? s / 100_000_000n : 1n;
    const done = (next > s ? next - s : s - next) <= tol;
    s = next;
    if (done) break;
  }
  const out = await quoteOrThrow(s);
  const walk = walkSqrtPriceAfter(state, out, zeroForOne);
  if (walk.sqrtPriceX96 === null) throw new OpenPlanError("pool-depth", "Swap would exhaust the liquidity known around the current price");
  if (!(spl < walk.sqrtPriceX96 && walk.sqrtPriceX96 < spu)) throw new OpenPlanError("split-not-found", "Post-swap price leaves the range");
  return { swapIn: s, amountOut: out, sqrtPriceAfterX96: walk.sqrtPriceX96, ticksCrossed: walk.ticksCrossed, iterations };
}

export type OpenAmounts = {
  /** "swap": UR sequence A (permit, transferFrom, V4_SWAP, SWEEP, POSM). "no-swap": sequence B (range on the deposit side). */
  kind: "swap" | "no-swap";
  zeroForOne: boolean;
  amountIn: bigint;
  swapIn: bigint;
  quoteOut: bigint;
  minOut: bigint;
  fee: bigint;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  priceTolBps: number;
  slippageBps: bigint;
  sqrtPriceAfterX96: bigint;
  ticksCrossed: number[];
  iterations: number;
};

const TOL_SCALE = 1_000_000_000n;

/**
 * Steps 1–4 of §3.10: split, slippage (5 bps on the Quoter output), fee = floor(10 bps × output), and
 * L = min(L0, L1) at the post-swap price widened by ±priceTol/2.
 */
export async function planOpenAmounts(args: {
  state: OpenPoolState; quote: QuoteFn; depositIsToken0: boolean; amountIn: bigint; tickLower: number; tickUpper: number; tickSpacing: number;
  priceTolBps?: number; slippageBps?: bigint;
}): Promise<OpenAmounts> {
  const { state, depositIsToken0: z, amountIn, tickLower, tickUpper } = args;
  assertOpenRange(tickLower, tickUpper, args.tickSpacing);
  if (amountIn <= 0n) throw new OpenPlanError("amount-invalid", "Deposit amount must be positive");
  const slip = args.slippageBps ?? SLIPPAGE_BPS;
  const tol = args.priceTolBps ?? defaultPriceTolBps(tickLower, tickUpper);
  const spl = sqrtPriceAtTick(tickLower), spu = sqrtPriceAtTick(tickUpper), sp = state.sqrtPriceX96;
  const base = { zeroForOne: z, amountIn, priceTolBps: tol, slippageBps: slip, ticksCrossed: [] as number[], iterations: 0 };
  // Range entirely on one side of the price: only one token is needed, no swap and no fee (sequence B).
  if (sp <= spl || sp >= spu) {
    const needsToken0 = sp <= spl;
    if (needsToken0 !== z)
      throw new OpenPlanError("range-wrong-side", `Range is entirely ${needsToken0 ? "above" : "below"} the price and needs only ${needsToken0 ? "token0" : "token1"}`);
    const liquidity = z ? liquidityFromAmount0(amountIn, spl, spu) : liquidityFromAmount1(amountIn, spl, spu);
    return { ...base, kind: "no-swap", swapIn: 0n, quoteOut: 0n, minOut: 0n, fee: 0n, liquidity,
      amount0Max: z ? amountIn : 0n, amount1Max: z ? 0n : amountIn, sqrtPriceAfterX96: sp };
  }
  const split = await solveSplit(state, args.quote, amountIn, tickLower, tickUpper, z);
  const fee = feeOf(split.amountOut);
  const minOut = split.amountOut * (10_000n - slip) / 10_000n;
  const netMin = minOut - feeOf(minOut);
  const netExpected = split.amountOut - fee;
  const keep = amountIn - split.swapIn;
  const f = BigInt(Math.round(tol / 20_000 * Number(TOL_SCALE)));
  const spLo = split.sqrtPriceAfterX96 * (TOL_SCALE - f) / TOL_SCALE;
  const spHi = split.sqrtPriceAfterX96 * (TOL_SCALE + f) / TOL_SCALE;
  const liquidity = z
    ? min(liquidityFromAmount0(keep, spLo, spu), liquidityFromAmount1(netMin, spl, spHi))
    : min(liquidityFromAmount0(netMin, spLo, spu), liquidityFromAmount1(keep, spl, spHi));
  if (liquidity <= 0n) throw new OpenPlanError("amount-invalid", "Amount too small for this range");
  return { ...base, kind: "swap", swapIn: split.swapIn, quoteOut: split.amountOut, minOut, fee, liquidity,
    amount0Max: z ? keep : netExpected, amount1Max: z ? netExpected : keep,
    sqrtPriceAfterX96: split.sqrtPriceAfterX96, ticksCrossed: split.ticksCrossed, iterations: split.iterations };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
