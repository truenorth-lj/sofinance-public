import { describe, expect, it } from "vitest";
import { aggregateOpensDaily, opensDailyCsv } from "./aggregate";
import type { OpenLogRecord } from "./types";

function rec(day: string, wallet: string, ref: string | null, notional: number | null, hour = 1): OpenLogRecord {
  return { day, wallet, ref, notionalUsd: notional, openedAtMs: Date.parse(`${day}T0${hour}:00:00Z`) };
}

describe("daily opens aggregation", () => {
  it("counts opens, unique wallets, first-day new wallets, notional, and ref breakdown", () => {
    const days = aggregateOpensDaily([
      rec("2026-10-18", "w1", "x-launch", 100),
      rec("2026-10-19", "w1", "x-launch", 50),
      rec("2026-10-19", "w2", null, 25),
      rec("2026-10-19", "w2", "x-other", 10, 2),
    ]);
    expect(days).toHaveLength(2);
    const second = days[1]!;
    expect(second).toMatchObject({
      date: "2026-10-19", opens: 3, uniqueWallets: 2, newUniqueWallets: 1, notionalUsd: 85,
    });
    expect(second.byRef).toEqual([
      { ref: null, opens: 1, uniqueWallets: 1, newUniqueWallets: 1, notionalUsd: 25 },
      { ref: "x-launch", opens: 1, uniqueWallets: 1, newUniqueWallets: 0, notionalUsd: 50 },
      { ref: "x-other", opens: 1, uniqueWallets: 1, newUniqueWallets: 0, notionalUsd: 10 },
    ]);
    expect(opensDailyCsv([second])).toContain("day,2026-10-19,,3,2,1,85");
    expect(opensDailyCsv([second])).toContain("ref,2026-10-19,x-launch,1,1,0,50");
  });
});
