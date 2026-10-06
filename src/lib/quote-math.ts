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
