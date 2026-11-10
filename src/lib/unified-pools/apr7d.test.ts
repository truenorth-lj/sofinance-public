import { describe, expect, it } from "vitest";
import { cardPayloadWithAprs, payloadWithAprs } from "@/lib/range-apr/payload.fixture";
import { payloadFixture } from "@/lib/range-apr/payload.fixture";
import { highestRangeSummary } from "@/lib/range-apr/preset-list";
import { payloadForCapital } from "@/lib/range-apr/size-aware";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { capAprAtPoolFees, CARD_APR_DEPOSIT_USD } from "@/lib/lp-plan-pool-terms";
import { cardDataDays, poolLpFeesPerDayUsd, rankGroupLookup, summarizeApr7d, type Apr7dState } from "./apr7d";
import type { UnifiedPool, UnifiedProtocol } from "./model";
import { resolveRhcPresetRanges } from "@/lib/rhc-range-apr-presets";
import { estimateRangeApr } from "@/lib/range-apr/range-apr";
import { toRangeAprInputs } from "@/lib/range-apr/selection";

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
  const uncappedAt1000 = (payload: ReturnType<typeof payloadFixture>) => highestRangeSummary(OPEN_RANGE_UI_PRESETS, payloadForCapital(payload, CARD_APR_DEPOSIT_USD))!.aprPct;
  /** Yearly % of a $1,000 deposit that took every fee the pool's LPs earned. */
  const allFeesPct = (feesPerDay: number) => feesPerDay * 365 / CARD_APR_DEPOSIT_USD * 100;

  it("SKHYx-like $126 pool: no APR when all preview ranges are excluded; the pool fee cap still holds", () => {
    const payload = thin(126);
    const fees = 1000 * 0.0005 * 0.84; // 7d avg volume × fee × LP share = $0.42 a day
    expect(poolLpFeesPerDayUsd(payload)).toBeCloseTo(fees, 12);
    const state = summarizeApr7d(payload, "raydium-clmm", NOW);
    expect(state.status).toBe("missing"); // all ranges fail the common $1,000 size-fit check
    expect(capAprAtPoolFees(1e6, { poolLpFeesPerDayUsd: fees, poolTvlUsd: 0 })).toBeCloseTo(allFeesPct(fees), 9);
  });
  it("a range that earns above the pool's average fee rate keeps its own number (no pool-average cap)", () => {
    const base = payloadFixture();
    const payload = fresh({ ...base, pool: { ...base.pool, tvlUsd: 1e9 } });
    const poolAvgPct = capAprAtPoolFees(1e6, { poolLpFeesPerDayUsd: poolLpFeesPerDayUsd(payload), poolTvlUsd: payload.pool.tvlUsd });
    const best = uncappedAt1000(payload);
    expect(best).toBeGreaterThan(poolAvgPct);
    expect(best).toBeLessThan(allFeesPct(poolLpFeesPerDayUsd(payload)!));
    const state = summarizeApr7d(payload, "raydium-clmm", NOW);
    expect(state.status === "ready" && state.aprPct).toBeCloseTo(best, 9);
    expect(state).toMatchObject({ status: "ready", rangeLabel: expect.any(String) });
  });
  it("caps a fitting reference-capital range at the pool's entire LP fee income", () => {
    const payload = cardPayloadWithAprs({ micro: 100, tight: 80, standard: 60, wide: 40 });
    payload.model.avgDailyVolumeUsd = 1000;
    const state = summarizeApr7d(fresh(payload), "raydium-clmm", NOW);
    expect(state.status === "ready" && state.aprPct).toBeCloseTo(allFeesPct(0.42), 9);
  });
  it("never raises an APR under the cap, and leaves it when the pool's fees are unknown", () => {
    expect(capAprAtPoolFees(5, { poolLpFeesPerDayUsd: 1_000, poolTvlUsd: 10_000 })).toBe(5);
    expect(capAprAtPoolFees(500, { poolLpFeesPerDayUsd: null, poolTvlUsd: 126 })).toBe(500);
  });
  it("does not name an actionable range when all $1,000 candidates are size-excluded", () => {
    const payload = thin(126);
    // The card must preserve the same exclusions as the Create position form.
    expect(payloadForCapital(payload, CARD_APR_DEPOSIT_USD).presets.some((preset) => preset.sizeFit?.status === "excluded")).toBe(true);
    expect(summarizeApr7d(payload, "raydium-clmm", NOW)).toMatchObject({ status: "missing" });
  });
});

describe("summarizeApr7d: protocol-specific size-fit eligibility", () => {
  const protocols: UnifiedProtocol[] = ["raydium-clmm", "orca-whirlpool", "meteora-dlmm", "uniswap-v4-rhc"];

  it.each(protocols)("%s only applies Raydium size-fit exclusions to Raydium cards", (protocol) => {
    const payload = fresh(cardPayloadWithAprs({ micro: 40, tight: 30, standard: 20, wide: 10 }));
    payload.presets = payload.presets.map((preset) => ({ ...preset, sizeFit: {
      status: "excluded", reason: "cross-band", ownSharePct: 1, edgeBps: 100, impactBps: 2, bandBps: 1,
    } }));
    const state = summarizeApr7d(payload, protocol, NOW);
    expect(state).toMatchObject(protocol === "raydium-clmm"
      ? { status: "missing" }
      : { status: "ready", aprPct: 40, rangeLabel: protocol === "uniswap-v4-rhc" ? "Min (±10 ticks)" : "Micro" });
  });

  it.each(protocols)("%s retains the shared preview, fee cap and missing-data gates", (protocol) => {
    const payload = fresh(payloadFixture()); // Served at $100, previewed at $1,000.
    payload.model.avgDailyVolumeUsd = 0.001;
    const state = summarizeApr7d(payload, protocol, NOW);
    const cap = poolLpFeesPerDayUsd(payload)! * 365 / CARD_APR_DEPOSIT_USD * 100;
    expect(state.status === "ready" && state.aprPct).toBeCloseTo(cap, 12);
    payload.presets = payload.presets.map((preset) => ({ ...preset,
      estimate: { status: "unavailable", reason: "range-outside-window" },
    }));
    expect(summarizeApr7d(payload, protocol, NOW).status).toBe("missing");
    payload.sample.degraded = true;
    expect(summarizeApr7d(payload, protocol, NOW)).toMatchObject({ status: "missing", degraded: true });
    const young = fresh(payloadFixture());
    young.sample.dataDays = 3;
    expect(summarizeApr7d(young, protocol, NOW)).toMatchObject({ status: "new", days: 3 });
    expect(summarizeApr7d(young, protocol, Date.parse(SNAPSHOT) + 49 * 3_600_000).status).toBe("missing");
  });

  it("keeps the real RHC Min candidate when only Raydium's constant-liquidity band guard fails", () => {
    const payload = fresh(payloadFixture());
    payload.model.currentSqrt = 1.0001 ** 0.125;
    payload.pool.currentPrice = payload.model.currentSqrt ** 2;
    payload.model.bins = payload.model.bins.map((bin) => ({ ...bin, liquidity: 1e7 }));
    payload.presets = resolveRhcPresetRanges(payload.pool).map((range) => ({
      ...range, estimate: estimateRangeApr(toRangeAprInputs(payload), range),
    }));
    const repriced = payloadForCapital(payload, CARD_APR_DEPOSIT_USD);
    expect(repriced.presets.map((preset) => preset.id)).toEqual(["micro", "standard", "wide"]);
    for (const preset of repriced.presets) {
      expect(preset.sizeFit).toMatchObject({ status: "excluded", reason: "cross-band" });
      expect(preset.sizeFit!.ownSharePct).toBeLessThan(10);
      expect(preset.sizeFit!.edgeBps).toBeGreaterThan(9);
      expect(preset.sizeFit!.impactBps).toBeCloseTo(1, 3);
      expect(preset.sizeFit!.bandBps).toBeCloseTo(0.25, 3);
    }
    const state = summarizeApr7d(payload, "uniswap-v4-rhc", NOW);
    expect(state).toMatchObject({ status: "ready", rangeLabel: "Min (±10 ticks)" });
    expect(state.status === "ready" && state.aprPct).toBeCloseTo(1.3940008194, 9);
    expect(summarizeApr7d(payload, "raydium-clmm", NOW)).toMatchObject({ status: "missing" });
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
