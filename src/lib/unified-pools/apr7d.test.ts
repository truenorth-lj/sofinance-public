import { describe, expect, it } from "vitest";
import { payloadWithAprs } from "@/lib/range-apr/payload.fixture";
import { payloadFixture } from "@/lib/range-apr/payload.fixture";
import { highestRangeSummary } from "@/lib/range-apr/preset-list";
import { payloadForCapital } from "@/lib/range-apr/size-aware";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { capAprAtPoolFees, CARD_APR_DEPOSIT_USD } from "@/lib/lp-plan-pool-terms";
import { cardDataDays, poolLpFeesPerDayUsd, rankGroupLookup, summarizeApr7d, type Apr7dState } from "./apr7d";
import type { UnifiedPool } from "./model";

const SNAPSHOT = "2026-11-04T08:17:54.000Z";
const NOW = Date.parse(SNAPSHOT) + 3_600_000;
/** AMZNx/AMZN `8ug1sF…` on 2026-11-04: Tight 122.84% from 6 days since launch (one launch day ≈ 83% of the volume). */
const amzn = (days: number) => {
  const payload = payloadWithAprs({ tight: 122.84 });
  payload.sample = { ...payload.sample, days };
  payload.freshness = { snapshotAt: SNAPSHOT, chainObservedAt: SNAPSHOT, volumeObservedAt: SNAPSHOT, stale: false };
  return payload;
};

describe("summarizeApr7d: 7-day minimum", () => {
  it("under 7 days of data is a new pool with its day count and no APR", () => {
    const state = summarizeApr7d(amzn(6), "raydium-clmm", NOW);
    expect(state).toMatchObject({ status: "new", days: 6 });
    expect(state).not.toHaveProperty("aprPct");
    expect(summarizeApr7d(amzn(1), "raydium-clmm", NOW)).toMatchObject({ status: "new", days: 1 });
  });
  it("7 days shows an APR", () => {
    expect(summarizeApr7d(amzn(7), "raydium-clmm", NOW)).toMatchObject({ status: "ready", aprPct: expect.any(Number) });
  });
  it("an expired snapshot stays '—' (missing), whatever its day count", () => {
    expect(summarizeApr7d(amzn(6), "raydium-clmm", Date.parse(SNAPSHOT) + 49 * 3_600_000).status).toBe("missing");
  });
});

const fresh = (payload: ReturnType<typeof payloadFixture>) => {
  payload.freshness = { snapshotAt: SNAPSHOT, chainObservedAt: SNAPSHOT, volumeObservedAt: SNAPSHOT, stale: false };
  return payload;
};

describe("summarizeApr7d: the best range's APR at a $1,000 deposit, held only to all of the pool's fees", () => {
  /** A thin pool: little liquidity in each bin, so a $1,000 deposit would take nearly all the fees of its range. */
  const thin = (tvlUsd: number) => {
    const base = payloadFixture();
    return fresh({ ...base, pool: { ...base.pool, tvlUsd }, model: { ...base.model, bins: base.model.bins.map((bin) => ({ ...bin, liquidity: 1e5 })) } });
  };
  const uncappedAt1000 = (payload: ReturnType<typeof payloadFixture>) => highestRangeSummary(OPEN_RANGE_UI_PRESETS, {
    ...payload, presets: payloadForCapital(payload, CARD_APR_DEPOSIT_USD).presets.map((preset) => { const copy = { ...preset }; delete copy.sizeFit; return copy; }),
  })!.aprPct;
  /** Yearly % of a $1,000 deposit that took every fee the pool's LPs earned. */
  const allFeesPct = (feesPerDay: number) => feesPerDay * 365 / CARD_APR_DEPOSIT_USD * 100;

  it("SKHYx-like $126 pool: never more than every fee the pool's LPs took (fees × 365 / $1,000)", () => {
    const payload = thin(126);
    const fees = 1000 * 0.0005 * 0.84; // 7d avg volume × fee × LP share = $0.42 a day
    expect(poolLpFeesPerDayUsd(payload)).toBeCloseTo(fees, 12);
    const state = summarizeApr7d(payload, "raydium-clmm", NOW);
    expect(state.status === "ready" && state.aprPct).toBeCloseTo(Math.min(uncappedAt1000(payload), allFeesPct(fees)), 9);
    expect(capAprAtPoolFees(1e6, { poolLpFeesPerDayUsd: fees, poolTvlUsd: 0 })).toBeCloseTo(allFeesPct(fees), 9);
  });
  it("a range that earns above the pool's average fee rate keeps its own number (no pool-average cap)", () => {
    const payload = thin(1e9);
    const poolAvgPct = capAprAtPoolFees(1e6, { poolLpFeesPerDayUsd: poolLpFeesPerDayUsd(payload), poolTvlUsd: payload.pool.tvlUsd });
    const best = uncappedAt1000(payload);
    expect(best).toBeGreaterThan(poolAvgPct);
    expect(best).toBeLessThan(allFeesPct(poolLpFeesPerDayUsd(payload)!));
    const state = summarizeApr7d(payload, "raydium-clmm", NOW);
    expect(state.status === "ready" && state.aprPct).toBeCloseTo(best, 9);
    expect(state).toMatchObject({ status: "ready", rangeLabel: expect.any(String) });
  });
  it("never raises an APR under the cap, and leaves it when the pool's fees are unknown", () => {
    expect(capAprAtPoolFees(5, { poolLpFeesPerDayUsd: 1_000, poolTvlUsd: 10_000 })).toBe(5);
    expect(capAprAtPoolFees(500, { poolLpFeesPerDayUsd: null, poolTvlUsd: 126 })).toBe(500);
  });
  it("prices the ranges at $1,000 with no size-fit exclusions (the card always names a range)", () => {
    const payload = thin(126);
    // The Create position modal would exclude every range for $1,000 here; the card still prices one.
    expect(payloadForCapital(payload, CARD_APR_DEPOSIT_USD).presets.some((preset) => preset.sizeFit?.status === "excluded")).toBe(true);
    expect(summarizeApr7d(payload, "raydium-clmm", NOW)).toMatchObject({ status: "ready", rangeLabel: expect.any(String) });
  });
});

describe("cardDataDays: the calculator's strict count (days with volume and TVL)", () => {
  it("uses the payload's dataDays, falling back to the sample's days on older snapshots", () => {
    const payload = payloadFixture();
    expect(cardDataDays({ ...payload, sample: { ...payload.sample, days: 7 } })).toBe(7);
    expect(cardDataDays({ ...payload, sample: { ...payload.sample, days: 7, dataDays: 5 } })).toBe(5);
  });
  it("a pool 7 calendar days old with 5 traded days is a new pool (INTCx 9Ur3…C41K)", () => {
    const payload = fresh(payloadFixture());
    payload.sample = { ...payload.sample, days: 7, dataDays: 5 };
    expect(summarizeApr7d(payload, "raydium-clmm", NOW)).toMatchObject({ status: "new", days: 5 });
  });
});

describe("rankGroupLookup", () => {
  it("puts a pool whose APR state is new in the New pool group; Not supported yet still wins", () => {
    const pool = (key: string, over: Partial<UnifiedPool> = {}) => ({ key, tvlUsd: 20_000, ...over }) as UnifiedPool;
    const apr: Record<string, Apr7dState> = { a: { status: "new", days: 3 }, b: { status: "ready", aprPct: 1, rangeLabel: "Tight", lowConfidence: false, avgDailyVolumeUsd: 1 } };
    const group = rankGroupLookup(apr);
    expect(group(pool("a"))).toBe(2);
    expect(group(pool("b"))).toBe(0);
    expect(group(pool("b", { tvlUsd: 4_999 }))).toBe(1);
    expect(group(pool("a", { unsupportedIssues: ["ScaledUiAmount multiplier not 1"] }))).toBe(3);
  });
});
