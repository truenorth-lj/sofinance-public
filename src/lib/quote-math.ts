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
