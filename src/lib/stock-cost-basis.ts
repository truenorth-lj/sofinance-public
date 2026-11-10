/**
 * Average-cost basis of a same-stock position in the report's base-side share unit, pure.
 * Amounts are token-equivalent at the report's `uiPriceBPerA` (current tick), the same conversion as `sharesNow`.
 * Per transaction, in chronological order:
 * - fees collected and put back in the same transaction (an atomic compound) are not outside money;
 * - the rest of a deposit adds shares at that deposit's entry price;
 * - a withdrawal removes shares at the current average cost, leaving the average unchanged.
 */
import type { PositionCashflowEvent } from "./position-performance-events";

export type CostBasisHistoryItem = { signature: string; slot: number; blockTime: number | null; events: readonly PositionCashflowEvent[] };
export type CostBasisPosition = {
  positionId: string;
  poolId: string;
  decimalsA: number;
  decimalsB: number;
  baseSide: "A" | "B";
  uiPriceBPerA: number;
};
/** A transaction that put outside money in: it needs a deposit-time price. */
export type CostBasisDeposit = { signature: string; slot: number; blockTime: number | null; shares: number };
export type CostBasisStep = CostBasisDeposit | { signature: string; slot: number; blockTime: number | null; shares: number; withdrawal: true };
export type CostBasis = { sharesIn: number; entryPriceUsd: number | null; missing: string[] };
/** What the stock view shows for the shares put in: average recorded deposit-time price, or why there is none. */
export type StockEntry = { sharesIn: number | null; entryPriceUsd: number | null; source: string | null; reason: string | null };

/** Shares below this are rounding left over after a full withdrawal. */
const EMPTY_SHARES = 1e-9;

function toBaseShares(rawA: bigint, rawB: bigint, position: CostBasisPosition): number {
  const a = Number(rawA) / 10 ** position.decimalsA, b = Number(rawB) / 10 ** position.decimalsB;
  return position.baseSide === "A" ? a + b / position.uiPriceBPerA : a * position.uiPriceBPerA + b;
}

/** Net outside shares per transaction: positive steps are deposits, negative ones withdrawals. */
export function costBasisSteps(history: readonly CostBasisHistoryItem[], position: CostBasisPosition): CostBasisStep[] {
  if (!(position.uiPriceBPerA > 0) || !Number.isFinite(position.uiPriceBPerA)) return [];
  const steps: CostBasisStep[] = [];
  const ordered = [...history].sort((a, b) => a.slot - b.slot);
  for (const item of ordered) {
    let depositA = 0n, depositB = 0n, principalA = 0n, principalB = 0n, feeA = 0n, feeB = 0n;
    for (const event of item.events) {
      if (event.kind === "open") {
        if (event.poolState !== position.poolId) continue;
        depositA += BigInt(event.amountA); depositB += BigInt(event.amountB);
      } else if (event.positionNftMint !== position.positionId) {
        continue;
      } else if (event.kind === "increase") {
        depositA += BigInt(event.amountA); depositB += BigInt(event.amountB);
      } else {
        principalA += BigInt(event.principalA); principalB += BigInt(event.principalB);
        feeA += BigInt(event.feeA); feeB += BigInt(event.feeB);
      }
    }
    const deposited = toBaseShares(depositA, depositB, position);
    const reinvestedFees = Math.min(deposited, toBaseShares(feeA, feeB, position));
    const net = deposited - reinvestedFees - toBaseShares(principalA, principalB, position);
    if (Math.abs(net) <= EMPTY_SHARES) continue;
    const base = { signature: item.signature, slot: item.slot, blockTime: item.blockTime };
    steps.push(net > 0 ? { ...base, shares: net } : { ...base, shares: -net, withdrawal: true });
  }
  return steps;
}

/** Steps after the last full withdrawal: earlier deposits no longer count toward the shares still in. */
function currentLot(steps: readonly CostBasisStep[]): readonly CostBasisStep[] {
  let shares = 0, start = 0;
  steps.forEach((step, index) => {
    shares = "withdrawal" in step ? Math.max(0, shares - step.shares) : shares + step.shares;
    if (shares <= EMPTY_SHARES) { shares = 0; start = index + 1; }
  });
  return steps.slice(start);
}

/** Deposits whose price the entry price depends on (only those still in after the last full withdrawal). */
export function depositsNeedingPrice(steps: readonly CostBasisStep[]): CostBasisDeposit[] {
  return currentLot(steps).filter((step): step is CostBasisDeposit => !("withdrawal" in step));
}

/** Shares still in and their average cost; `missing` lists deposits without a price (then no entry price). */
export function averageCost(steps: readonly CostBasisStep[], prices: ReadonlyMap<string, number>): CostBasis {
  let shares = 0, cost = 0;
  const missing: string[] = [];
  for (const step of currentLot(steps)) {
    if ("withdrawal" in step) {
      const removed = Math.min(step.shares, shares);
      cost = shares > 0 ? cost * (1 - removed / shares) : 0;
      shares -= removed;
      continue;
    }
    const price = prices.get(step.signature);
    if (price === undefined) missing.push(step.signature);
    shares += step.shares;
    cost += step.shares * (price ?? 0);
  }
  const entryPriceUsd = !missing.length && shares > EMPTY_SHARES ? cost / shares : null;
  return { sharesIn: shares, entryPriceUsd, missing };
}
