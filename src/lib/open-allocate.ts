/**
 * Open-position spend allocation: the engine's current 5×2 convergence loop, plus a
 * single-shot prototype (one pool-price allocation, one quote per leg).
 *
 * Production `/api/open-quote` still uses the engine loop (`OPEN_POSITION_ALLOCATE_MODE`).
 * Switching the live path needs an engine `allocateMode` flag — this module is the
 * measured prototype and the keep-the-loop switch.
 */
import BN from "bn.js";
import { LiquidityMathUtil, SqrtPriceMath } from "@raydium-io/raydium-sdk-v2";
import { DEFAULT_ADD_TOLERANCE_BPS } from "@sofinance/engine/ids";
import { allocateSpend, poolPriceRates, sizingAmountsConverged, SIZING_CONVERGE_BPS, toleranceLiquidity } from "@sofinance/engine/quote-math";

export const OPEN_ALLOCATE_MODES = ["loop", "single-shot", "single-shot-adjusted"] as const;
export type OpenAllocateMode = (typeof OPEN_ALLOCATE_MODES)[number];

/**
 * Ship default stays on the loop. Live quotes (SNDK/SPCX/TSLA at $100/$1000,
 * 2026-10-23) showed single-shot leftover matching the loop on deep/small
 * deposits, but +14% of deposit unpaired on SNDK $1000 Standard; the
 * fee/impact pre-adjust made thin pools worse. See `scripts/measure-open-allocate.ts`.
 */
export const OPEN_POSITION_ALLOCATE_MODE: OpenAllocateMode = "loop";

/** Extra unpaired % of deposit at which single-shot is treated as materially worse than the loop. */
export const MATERIAL_LEFTOVER_PCT = 0.5;

export const ALLOCATE_MAX_ROUNDS = 5;
/** Engine: `SIZING_CONVERGE_BPS` → 1%. */
export const ALLOCATE_CONVERGE_NUM = BigInt(SIZING_CONVERGE_BPS);
export const ALLOCATE_CONVERGE_DEN = 10_000n;

const UNIT_LIQUIDITY = new BN("1000000000000000000");

export type OpenAllocatePool = {
  mintA: string;
  mintB: string;
  sqrtPriceX64: string;
  tickCurrent: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  lowerSqrtX64: string;
  upperSqrtX64: string;
  poolLiquidity: string;
  feeTierBps: number;
};

export type OpenAllocateQuote = {
  spend: bigint;
  minOut: bigint;
  /** Raw input on a hop that touches the target pool (for the loop's price projection). */
  ownPoolIn?: bigint;
  ownPoolZeroForOne?: boolean;
};

export type OpenAllocateQuoteFn = (side: "A" | "B", spend: bigint) => Promise<OpenAllocateQuote>;

export type OpenAllocateResult = {
  mode: OpenAllocateMode;
  rounds: number;
  quotes: number;
  spendA: bigint;
  spendB: bigint;
  outA: bigint;
  outB: bigint;
  requiredA: bigint;
  requiredB: bigint;
  dustA: bigint;
  dustB: bigint;
  unpairedInput: bigint;
  unpairedPct: number;
  /** Leftover if liquidity were sized from minOut with no 1% reserve (ratio mismatch only). */
  mismatchInput: bigint;
  mismatchPct: number;
  elapsedMs: number;
  converged: boolean;
};

export function parseOpenAllocateMode(value: unknown): OpenAllocateMode {
  if (typeof value === "string" && (OPEN_ALLOCATE_MODES as readonly string[]).includes(value)) {
    return value as OpenAllocateMode;
  }
  return OPEN_POSITION_ALLOCATE_MODE;
}

function amountsAt(pool: OpenAllocatePool, sqrt: BN) {
  return LiquidityMathUtil.getAmountsForLiquidity(
    sqrt, new BN(pool.lowerSqrtX64), new BN(pool.upperSqrtX64), UNIT_LIQUIDITY, true,
  );
}

function projectSqrt(pool: OpenAllocatePool, quotes: OpenAllocateQuote[]): BN {
  let price = new BN(pool.sqrtPriceX64);
  const liquidity = new BN(pool.poolLiquidity);
  if (liquidity.isZero()) return price;
  for (const quote of quotes) {
    if (quote.ownPoolIn === undefined || quote.ownPoolZeroForOne === undefined || quote.ownPoolIn <= 0n) continue;
    price = SqrtPriceMath.getNextSqrtPriceFromInput(
      price, liquidity, new BN(quote.ownPoolIn.toString()), quote.ownPoolZeroForOne,
    );
  }
  return price;
}

function haircutRates(rates: ReturnType<typeof poolPriceRates>, feeTierBps: number) {
  if (!Number.isInteger(feeTierBps) || feeTierBps <= 0) return rates;
  const keep = 10_000n - BigInt(feeTierBps);
  return {
    rateA: { spend: rates.rateA.spend, out: rates.rateA.out * keep / 10_000n },
    rateB: { spend: rates.rateB.spend, out: rates.rateB.out * keep / 10_000n },
  };
}

/** First (and single-shot) spendA from the current pool price and range amounts. */
export function poolPriceSpendA(pool: OpenAllocatePool, requested: bigint): bigint {
  const base = amountsAt(pool, new BN(pool.sqrtPriceX64));
  const rates = poolPriceRates(pool.sqrtPriceX64);
  return allocateSpend(
    requested, BigInt(base.amountA.toString()), BigInt(base.amountB.toString()),
    rates.rateA, rates.rateB, 1n,
  );
}

/**
 * Single-shot spendA after a fee haircut and an estimated own-pool move
 * (half the B-leg swapped B→A through current pool liquidity).
 */
export function adjustedPoolPriceSpendA(pool: OpenAllocatePool, requested: bigint): bigint {
  const first = poolPriceSpendA(pool, requested);
  const spendB = requested - first;
  let projected = new BN(pool.sqrtPriceX64);
  const liquidity = new BN(pool.poolLiquidity);
  if (!liquidity.isZero() && spendB > 0n) {
    projected = SqrtPriceMath.getNextSqrtPriceFromInput(projected, liquidity, new BN(spendB.toString()), false);
  }
  const lower = new BN(pool.lowerSqrtX64);
  const upper = new BN(pool.upperSqrtX64);
  if (projected.lte(lower) || projected.gte(upper)) return first;
  const desired = amountsAt(pool, projected);
  const amountA = BigInt(desired.amountA.toString());
  const amountB = BigInt(desired.amountB.toString());
  if (amountA <= 0n || amountB <= 0n) return first;
  const rates = haircutRates(poolPriceRates(projected.toString()), pool.feeTierBps);
  if (rates.rateA.out <= 0n || rates.rateB.out <= 0n) return first;
  try {
    return allocateSpend(requested, amountA, amountB, rates.rateA, rates.rateB, 1n);
  } catch {
    return first;
  }
}

function sizeFromOutputs(
  pool: OpenAllocatePool, requested: bigint, spendA: bigint, outA: bigint, outB: bigint,
  projected: BN, toleranceBps: number,
) {
  const spendB = requested - spendA;
  const fullLiquidity = LiquidityMathUtil.getLiquidityFromAmounts(
    projected, new BN(pool.lowerSqrtX64), new BN(pool.upperSqrtX64),
    new BN(outA.toString()), new BN(outB.toString()),
  );
  fullLiquidity.isubn(1);
  const loose = BigInt(fullLiquidity.toString());
  const tight = toleranceLiquidity(loose < 0n ? 0n : loose, toleranceBps);
  const requiredAt = (liquidity: bigint) => {
    if (liquidity <= 0n) return { requiredA: 0n, requiredB: 0n };
    const amounts = LiquidityMathUtil.getAmountsForLiquidity(
      projected, new BN(pool.lowerSqrtX64), new BN(pool.upperSqrtX64), new BN(liquidity.toString()), true,
    );
    return { requiredA: BigInt(amounts.amountA.toString()), requiredB: BigInt(amounts.amountB.toString()) };
  };
  const sized = requiredAt(tight);
  const unbound = requiredAt(loose < 0n ? 0n : loose);
  const dustA = outA > sized.requiredA ? outA - sized.requiredA : 0n;
  const dustB = outB > sized.requiredB ? outB - sized.requiredB : 0n;
  const mismatchA = outA > unbound.requiredA ? outA - unbound.requiredA : 0n;
  const mismatchB = outB > unbound.requiredB ? outB - unbound.requiredB : 0n;
  const toInput = (a: bigint, b: bigint) =>
    (outA > 0n ? a * spendA / outA : 0n) + (outB > 0n ? b * spendB / outB : 0n);
  const unpairedInput = toInput(dustA, dustB);
  const mismatchInput = toInput(mismatchA, mismatchB);
  const pct = (value: bigint) => requested > 0n ? Number(value * 100_000n / requested) / 1_000 : 0;
  return {
    spendA, spendB, outA, outB, requiredA: sized.requiredA, requiredB: sized.requiredB,
    dustA, dustB, unpairedInput, unpairedPct: pct(unpairedInput),
    mismatchInput, mismatchPct: pct(mismatchInput),
  };
}

function converged(next: bigint, spendA: bigint, requested: bigint) {
  return sizingAmountsConverged(next, spendA, requested);
}

export async function allocateOpenPosition(input: {
  pool: OpenAllocatePool;
  requested: bigint;
  mode?: OpenAllocateMode;
  quote: OpenAllocateQuoteFn;
  toleranceBps?: number;
  /** When false, a loop that never hits 1% still sizes from the last quotes (for measurement). */
  strict?: boolean;
  now?: () => number;
}): Promise<OpenAllocateResult> {
  const mode = input.mode ?? OPEN_POSITION_ALLOCATE_MODE;
  const toleranceBps = input.toleranceBps ?? DEFAULT_ADD_TOLERANCE_BPS;
  const started = (input.now ?? Date.now)();
  const { pool, requested, quote } = input;
  if (requested <= 0n) throw new Error("Input amount too small to allocate");

  let spendA = mode === "single-shot-adjusted"
    ? adjustedPoolPriceSpendA(pool, requested)
    : poolPriceSpendA(pool, requested);
  let rounds = 0;
  let quotes = 0;
  let legs: OpenAllocateQuote[] = [];
  let projected = new BN(pool.sqrtPriceX64);
  let didConverge = mode !== "loop";

  const quoteRound = async (nextSpendA: bigint) => {
    rounds += 1;
    const [actualA, actualB] = await Promise.all([
      quote("A", nextSpendA),
      quote("B", requested - nextSpendA),
    ]);
    quotes += 2;
    return [actualA, actualB] as const;
  };

  if (mode === "loop") {
    for (let index = 0; index < ALLOCATE_MAX_ROUNDS; index++) {
      legs = [...await quoteRound(spendA)];
      projected = projectSqrt(pool, legs);
      const desired = amountsAt(pool, projected);
      const next = allocateSpend(
        requested, BigInt(desired.amountA.toString()), BigInt(desired.amountB.toString()),
        { spend: spendA, out: legs[0]!.minOut }, { spend: requested - spendA, out: legs[1]!.minOut }, 1n,
      );
      if (converged(next, spendA, requested)) { didConverge = true; break; }
      if (index === ALLOCATE_MAX_ROUNDS - 1) {
        if (input.strict !== false) throw new Error("Pool price and swap ratio did not converge, please retry later");
        didConverge = false;
        break;
      }
      spendA = next;
    }
  } else {
    legs = [...await quoteRound(spendA)];
    projected = projectSqrt(pool, legs);
    didConverge = true;
  }

  const sized = sizeFromOutputs(
    pool, requested, spendA, legs[0]!.minOut, legs[1]!.minOut, projected, toleranceBps,
  );
  return {
    mode, rounds, quotes, ...sized, elapsedMs: (input.now ?? Date.now)() - started, converged: didConverge,
  };
}

export function extraUnpairedPct(singleShot: OpenAllocateResult, loop: OpenAllocateResult) {
  return singleShot.unpairedPct - loop.unpairedPct;
}

export function leftoverIsMateriallyWorse(singleShot: OpenAllocateResult, loop: OpenAllocateResult) {
  return extraUnpairedPct(singleShot, loop) > MATERIAL_LEFTOVER_PCT;
}
