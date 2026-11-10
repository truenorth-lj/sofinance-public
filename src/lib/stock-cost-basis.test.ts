import { describe, expect, it } from "vitest";
import type { PositionCashflowEvent } from "./position-performance-events";
import { averageCost, costBasisSteps, depositsNeedingPrice, type CostBasisHistoryItem, type CostBasisPosition } from "./stock-cost-basis";

const POOL = "FjUosHaSbH6XWodwzNfq2bFeSJkmdLkwi66zBjzc8KKS";
const POSITION = "2Q8xUv6AaRo3tPb1SjToizHEyYwumgYPU5GM1PtmBsuo";
const OWNER = "Owner1111111111111111111111111111111111111";
// NVDA (Backpack, 6 decimals) / NVDAx (8 decimals): base side A, about 0.9995 NVDAx per NVDA in raw units.
const position: CostBasisPosition = { positionId: POSITION, poolId: POOL, decimalsA: 6, decimalsB: 8, baseSide: "A", uiPriceBPerA: 0.9995 };

const open = (amountA: string, amountB: string): PositionCashflowEvent =>
  ({ kind: "open", poolState: POOL, nftOwner: OWNER, tickLower: 45960, tickUpper: 46140, liquidity: "734079211", amountA, amountB });
const increase = (amountA: string, amountB: string, mint = POSITION): PositionCashflowEvent =>
  ({ kind: "increase", positionNftMint: mint, liquidity: "1", amountA, amountB });
const decrease = (principalA: string, principalB: string, feeA = "0", feeB = "0"): PositionCashflowEvent =>
  ({ kind: "decrease", positionNftMint: POSITION, liquidity: "1", principalA, principalB, feeA, feeB });
let slot = 100;
const tx = (signature: string, ...events: PositionCashflowEvent[]): CostBasisHistoryItem => ({ signature, slot: slot++, blockTime: 1_794_250_173, events });

describe("cost basis in base-side shares", () => {
  it("prices the NVDA example's opening deposit at the deposit-time trades", () => {
    // Amounts from the opening event of 4SEHvb3M… (2026-11-09 18:49:33 UTC).
    const steps = costBasisSteps([tx("4SEHvb3M", open("344847", "31431638"))], position);
    expect(depositsNeedingPrice(steps).map((step) => step.signature)).toEqual(["4SEHvb3M"]);
    const basis = averageCost(steps, new Map([["4SEHvb3M", 176.998]]));
    expect(basis.sharesIn).toBeCloseTo(0.344847 + 0.31431638 / 0.9995, 9);
    expect(basis.entryPriceUsd).toBeCloseTo(176.998, 6);
  });

  it("averages deposits and keeps the average through a withdrawal", () => {
    const steps = costBasisSteps([tx("d1", open("1000000", "0")), tx("d2", increase("3000000", "0")), tx("w1", decrease("2000000", "0"))], position);
    const basis = averageCost(steps, new Map([["d1", 100], ["d2", 120]]));
    expect(basis.sharesIn).toBeCloseTo(2, 9);
    expect(basis.entryPriceUsd).toBeCloseTo(115, 9);
  });

  it("does not count fees collected and put back in the same transaction as outside money", () => {
    const first = tx("d1", open("1000000", "0"));
    const compound = tx("c1", decrease("0", "0", "20000", "0"), increase("20000", "0"));
    const topUp = tx("c2", decrease("0", "0", "10000", "0"), increase("1010000", "0"));
    const steps = costBasisSteps([topUp, first, compound], position);
    expect(depositsNeedingPrice(steps).map((step) => [step.signature, step.shares])).toEqual([["d1", 1], ["c2", 1]]);
    expect(averageCost(steps, new Map([["d1", 100], ["c2", 110]])).entryPriceUsd).toBeCloseTo(105, 9);
  });

  it("starts over after a full withdrawal: earlier deposits need no price", () => {
    const steps = costBasisSteps([tx("old", open("1000000", "0")), tx("out", decrease("1000000", "0")), tx("new", increase("2000000", "0"))], position);
    expect(depositsNeedingPrice(steps).map((step) => step.signature)).toEqual(["new"]);
    expect(averageCost(steps, new Map([["new", 130]]))).toEqual({ sharesIn: 2, entryPriceUsd: 130, missing: [] });
  });

  it("has no entry price while any deposit still in lacks a price", () => {
    const steps = costBasisSteps([tx("d1", open("1000000", "0")), tx("d2", increase("1000000", "0"))], position);
    expect(averageCost(steps, new Map([["d1", 100]]))).toMatchObject({ sharesIn: 2, entryPriceUsd: null, missing: ["d2"] });
  });

  it("converts the other side's amounts with the report's price and ignores other positions", () => {
    const steps = costBasisSteps([tx("d1", open("0", "99950000")), tx("x", increase("5000000", "0", "Other111111111111111111111111111111111111111"))], position);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.shares).toBeCloseTo(1, 9);
  });
});
