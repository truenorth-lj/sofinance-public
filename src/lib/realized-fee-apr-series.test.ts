import { describe, expect, it } from "vitest";
import { buildRealizedFeeAprSeries } from "./realized-fee-apr-series";

const POSITION = "Pos11111111111111111111111111111111111111";
const POOL = "Pool1111111111111111111111111111111111111";
const OPENED = 1_790_985_600; // 2026-10-03 00:00 UTC
const MID = OPENED + 2 * 86_400;
const NOW = OPENED + 6 * 86_400;

describe("buildRealizedFeeAprSeries", () => {
  it("emits event-day and evaluation-day points and leaves other days out", () => {
    const series = buildRealizedFeeAprSeries({
      history: [
        {
          blockTime: OPENED,
          events: [
            {
              kind: "open",
              poolState: POOL,
              nftOwner: "Own11111111111111111111111111111111111111",
              tickLower: 0,
              tickUpper: 10,
              liquidity: "1",
              amountA: "0",
              amountB: "100000000",
            },
          ],
        },
        {
          blockTime: MID,
          events: [
            {
              kind: "decrease",
              positionNftMint: POSITION,
              liquidity: "0",
              principalA: "0",
              principalB: "0",
              feeA: "0",
              feeB: "1000000",
            },
          ],
        },
      ],
      positionMint: POSITION,
      poolId: POOL,
      evaluatedAt: NOW,
      uncollectedFees: { a: 0n, b: 1_000_000n },
      priceUsdA: 1,
      priceUsdB: 1,
      decimalsA: 6,
      decimalsB: 6,
      openedAt: OPENED,
    });

    expect(series.points.map((p) => p.date)).toEqual(["2026-10-03", "2026-10-05", "2026-10-09"]);
    expect(series.points[0]).toMatchObject({ kind: "event", includeUncollected: false, aprPct: null });
    // 1 / 100 * 365 / 2 * 100 = 182.5  (collected only, 2 days)
    expect(series.points[1]?.aprPct).toBeCloseTo(182.5, 6);
    expect(series.points[1]?.includeUncollected).toBe(false);
    // 2 / 100 * 365 / 6 * 100 ≈ 121.666  (collected + uncollected, 6 days)
    expect(series.points[2]?.kind).toBe("evaluation");
    expect(series.points[2]?.includeUncollected).toBe(true);
    expect(series.points[2]?.aprPct).toBeCloseTo((2 / 100) * (365 / 6) * 100, 6);
  });

  it("returns null APR when USD prices are missing rather than inventing token-native points", () => {
    const series = buildRealizedFeeAprSeries({
      history: [
        {
          blockTime: OPENED,
          events: [
            {
              kind: "open",
              poolState: POOL,
              nftOwner: "Own11111111111111111111111111111111111111",
              tickLower: 0,
              tickUpper: 10,
              liquidity: "1",
              amountA: "10",
              amountB: "10",
            },
          ],
        },
      ],
      positionMint: POSITION,
      poolId: POOL,
      evaluatedAt: NOW,
      uncollectedFees: { a: 1n, b: 0n },
      priceUsdA: null,
      priceUsdB: null,
      decimalsA: 6,
      decimalsB: 6,
      openedAt: OPENED,
    });
    expect(series.points.length).toBeGreaterThan(0);
    expect(series.points.every((p) => p.aprPct === null)).toBe(true);
  });

  it("does not emit a point for events without a block time", () => {
    const series = buildRealizedFeeAprSeries({
      history: [
        {
          blockTime: null,
          events: [
            {
              kind: "increase",
              positionNftMint: POSITION,
              liquidity: "1",
              amountA: "0",
              amountB: "1",
            },
          ],
        },
      ],
      positionMint: POSITION,
      poolId: POOL,
      evaluatedAt: NOW,
      uncollectedFees: { a: 0n, b: 0n },
      priceUsdA: 1,
      priceUsdB: 1,
      decimalsA: 6,
      decimalsB: 6,
      openedAt: null,
    });
    expect(series.points).toEqual([]);
  });
});
