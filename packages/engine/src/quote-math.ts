export function positionSide(price: bigint, lower: bigint, upper: bigint): "below" | "inside" | "above" {
  if (lower >= upper) throw new Error("Invalid position ticks range");
  if (price <= lower) return "below";
  if (price >= upper) return "above";
  return "inside";
}

export function allocateSpend(total: bigint, targetA: bigint, targetB: bigint, rateA: { spend: bigint; out: bigint }, rateB: { spend: bigint; out: bigint }, minimumLeg = 1_000_000n): bigint {
  if (targetA <= 0n || targetB <= 0n || rateA.out <= 0n || rateB.out <= 0n) throw new Error("Invalid position allocation or route output");
  const costA = targetA * rateA.spend * rateB.out;
  const costB = targetB * rateB.spend * rateA.out;
  const allocation = total * costA / (costA + costB);
  if (allocation < minimumLeg || total - allocation < minimumLeg) {
    throw new Error(minimumLeg === 1_000_000n ? "Single-side amount required for narrow range below 1 USDC, execution halted" : "Single-side amount required for narrow range too small, execution halted");
  }
  return allocation;
}

const Q128 = 1n << 128n;

/**
 * Value-equivalent swap rates into token A and token B at the pool price, for the
 * first sizing round. Replaces separate Jupiter "probe" quotes: only the ratio
 * matters to `allocateSpend`, and each real leg's own `priceImpactPct` is capped
 * by the quote guards.
 */
export function poolPriceRates(sqrtPriceX64: string | bigint) {
  const sqrt = BigInt(sqrtPriceX64);
  if (sqrt <= 0n) throw new Error("Invalid pool price");
  const priceNumerator = sqrt * sqrt; // raw B per raw A = priceNumerator / 2^128
  return {
    rateA: { spend: 1n, out: Q128 },
    rateB: { spend: 1n, out: priceNumerator },
    /** Swapping token A into token B at the pool price. */
    aToB: { spend: Q128, out: priceNumerator },
    /** Swapping token B into token A at the pool price. */
    bToA: { spend: priceNumerator, out: Q128 },
  };
}

export function quoteIsFresh(expiresAt: number, now = Date.now()) {
  return Number.isFinite(expiresAt) && now < expiresAt;
}

// Shrink liquidity so that, at the projected price, each side needs at most
// out / (1 + tolerance). Any side may then grow by `toleranceBps` (pool price
// drift before execution) and still fit inside the guaranteed swap output.
export function toleranceLiquidity(liquidity: bigint, toleranceBps: number): bigint {
  if (liquidity < 0n || !Number.isInteger(toleranceBps) || toleranceBps < 0) throw new Error("Invalid liquidity tolerance input");
  return liquidity * 10_000n / (10_000n + BigInt(toleranceBps));
}

// amountMax handed to increase_liquidity_v2: the required amount padded by the
// tolerance, never above the conservative swap output (minOut), so the
// instruction can never draw on assets the wallet already held.
export function padAmountMax(required: bigint, available: bigint, toleranceBps: number): bigint {
  if (required < 0n || available < required || !Number.isInteger(toleranceBps) || toleranceBps < 0) {
    throw new Error("Invalid amountMax padding input");
  }
  const padded = (required * (10_000n + BigInt(toleranceBps)) + 9_999n) / 10_000n;
  return padded < available ? padded : available;
}

/** Open-position sizing: consecutive amounts within this many bps of `scale` have converged. */
export const SIZING_CONVERGE_BPS = 100;
export const SIZING_LOOP_ROUNDS = 5;
export const SIZING_BINARY_SEARCH_ROUNDS = 8;
export const SIZING_DID_NOT_CONVERGE_MESSAGE = "Pool price and swap ratio did not converge, please retry later";

export function sizingDifference(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/** True when `|a - b| / scale` is at most `SIZING_CONVERGE_BPS` (1%). */
export function sizingAmountsConverged(a: bigint, b: bigint, scale: bigint): boolean {
  if (a === b) return true;
  if (scale <= 0n) return false;
  return sizingDifference(a, b) * 10_000n <= scale * BigInt(SIZING_CONVERGE_BPS);
}

/** Never overspend: leftover dust stays in the wallet. */
export function conservativeSizingAmount(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function sizingMidpoint(lo: bigint, hi: bigint): bigint {
  return lo + (hi - lo) / 2n;
}

/**
 * Iterate `quoteRound(spend)` until consecutive spends are within 1% of `scale`, then keep the
 * smaller (conservative) amount. If the inner loop does not settle, binary-search the last
 * interval. `quoteRound` must quote at `spend` and return the allocator's next spend.
 */
export async function settleSizingSpend(
  initial: bigint,
  scale: bigint,
  quoteRound: (spend: bigint) => Promise<bigint>,
): Promise<bigint> {
  let current = initial;
  let next = initial;
  for (let index = 0; index < SIZING_LOOP_ROUNDS; index++) {
    next = await quoteRound(current);
    if (sizingAmountsConverged(next, current, scale)) {
      const chosen = conservativeSizingAmount(current, next);
      if (chosen !== current) await quoteRound(chosen);
      return chosen;
    }
    if (index < SIZING_LOOP_ROUNDS - 1) current = next;
  }
  let lo = conservativeSizingAmount(current, next);
  let hi = current > next ? current : next;
  for (let index = 0; index < SIZING_BINARY_SEARCH_ROUNDS; index++) {
    if (hi <= lo || sizingAmountsConverged(lo, hi, scale)) {
      if (current !== lo) await quoteRound(lo);
      return lo;
    }
    const mid = sizingMidpoint(lo, hi);
    if (mid === lo || mid === hi) {
      if (current !== lo) await quoteRound(lo);
      return lo;
    }
    next = await quoteRound(mid);
    current = mid;
    if (sizingAmountsConverged(next, mid, scale)) {
      const chosen = conservativeSizingAmount(mid, next);
      if (chosen !== mid) await quoteRound(chosen);
      return chosen;
    }
    if (next < mid) hi = mid;
    else lo = mid;
  }
  throw new Error(SIZING_DID_NOT_CONVERGE_MESSAGE);
}
