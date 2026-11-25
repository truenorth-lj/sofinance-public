import { describe, expect, it } from "vitest";
import { cardPayloadWithAprs, payloadWithAprs } from "@/lib/range-apr/payload.fixture";
import { payloadFixture } from "@/lib/range-apr/payload.fixture";
import { highestRangeSummary } from "@/lib/range-apr/preset-list";
import { payloadForCapital } from "@/lib/range-apr/size-aware";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { capAprAtPoolFees, CARD_APR_DEPOSIT_USD } from "@/lib/lp-plan-pool-terms";
import { cardDataDays, cardWindowDays, poolLpFeesPerDayUsd, rankGroupLookup, summarizeApr7d } from "./apr7d";
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

describe("summarizeApr7d: show an estimate from 1 complete UTC day", () => {
  it("1–6 days shows the APR and the window length", () => {
    const six = summarizeApr7d(amzn(6), "raydium-clmm", NOW);
    expect(six).toMatchObject({ status: "ready", days: 6, aprPct: expect.any(Number) });
    expect(summarizeApr7d(amzn(1), "raydium-clmm", NOW)).toMatchObject({ status: "ready", days: 1, aprPct: expect.any(Number) });
  });
  it("0 complete days is too new, with no APR", () => {
    const state = summarizeApr7d(amzn(0), "raydium-clmm", NOW);
    expect(state).toMatchObject({ status: "new", days: 0 });
    expect(state).not.toHaveProperty("aprPct");
  });
  it("7 days shows an APR", () => {
    expect(summarizeApr7d(amzn(7), "raydium-clmm", NOW)).toMatchObject({ status: "ready", days: 7, aprPct: expect.any(Number) });
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

  it("SKHYx-like $126 pool: shows the fee-capped 7-day APR", () => {
    const payload = thin(126);
    const fees = 1000 * 0.0005 * 0.84; // 7d avg volume × fee × LP share = $0.42 a day
    expect(poolLpFeesPerDayUsd(payload)).toBeCloseTo(fees, 12);
    const state = summarizeApr7d(payload, "raydium-clmm", NOW);
    expect(state.status).toBe("ready");
    expect(state.status === "ready" && state.aprPct).toBeGreaterThan(0);
    expect(state.status === "ready" && state.aprPct).toBeLessThanOrEqual(allFeesPct(fees) + 1e-9);
    expect(state).toMatchObject({ status: "ready", rangeLabel: expect.any(String) });
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
  it("names the best range on a thin pool's card", () => {
    const payload = thin(126);
    expect(summarizeApr7d(payload, "raydium-clmm", NOW)).toMatchObject({ status: "ready", rangeLabel: expect.any(String) });
  });
});

describe("summarizeApr7d: every protocol shows the best 7-day range", () => {
  const protocols: UnifiedProtocol[] = ["raydium-clmm", "orca-whirlpool", "meteora-dlmm", "uniswap-v4-rhc"];

  it.each(protocols)("%s ignores leftover size-fit metadata and shows the highest range", (protocol) => {
    const payload = fresh(cardPayloadWithAprs({ micro: 40, tight: 30, standard: 20, wide: 10 }));
    payload.presets = payload.presets.map((preset) => ({ ...preset, sizeFit: {
      status: "excluded", reason: "cross-band", ownSharePct: 1, edgeBps: 100, impactBps: 2, bandBps: 1,
    } }));
    const state = summarizeApr7d(payload, protocol, NOW);
    expect(state).toMatchObject({
      status: "ready", aprPct: 40, rangeLabel: protocol === "uniswap-v4-rhc" ? "Min (±10 ticks)" : "Micro",
    });
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
    young.sample.days = 3;
    young.sample.dataDays = 3;
    expect(summarizeApr7d(young, protocol, NOW)).toMatchObject({ status: "ready", days: 3, aprPct: expect.any(Number) });
    const empty = fresh(payloadFixture());
    empty.sample.days = 0;
    expect(summarizeApr7d(empty, protocol, NOW)).toMatchObject({ status: "new", days: 0 });
    expect(summarizeApr7d(empty, protocol, Date.parse(SNAPSHOT) + 49 * 3_600_000).status).toBe("missing");
  });

  it("keeps the real RHC Min candidate (and the same number on Raydium)", () => {
    const payload = fresh(payloadFixture());
    payload.model.currentSqrt = 1.0001 ** 0.125;
    payload.pool.currentPrice = payload.model.currentSqrt ** 2;
    payload.model.bins = payload.model.bins.map((bin) => ({ ...bin, liquidity: 1e7 }));
    payload.presets = resolveRhcPresetRanges(payload.pool).map((range) => ({
      ...range, estimate: estimateRangeApr(toRangeAprInputs(payload), range),
    }));
    const repriced = payloadForCapital(payload, CARD_APR_DEPOSIT_USD);
    expect(repriced.presets.map((preset) => preset.id)).toEqual(["micro", "standard", "wide"]);
    for (const preset of repriced.presets) expect(preset).not.toHaveProperty("sizeFit");
    const state = summarizeApr7d(payload, "uniswap-v4-rhc", NOW);
    expect(state).toMatchObject({ status: "ready", rangeLabel: "Min (±10 ticks)" });
    expect(state.status === "ready" && state.aprPct).toBeCloseTo(1.3940008194, 9);
    const raydium = summarizeApr7d(payload, "raydium-clmm", NOW);
    expect(raydium).toMatchObject({ status: "ready", rangeLabel: "Micro" });
    expect(raydium.status === "ready" && raydium.aprPct).toBeCloseTo(1.3940008194, 9);
  });
});

describe("cardWindowDays / cardDataDays", () => {
  it("cardDataDays uses the payload's dataDays, falling back to the sample's days on older snapshots", () => {
    const payload = payloadFixture();
    expect(cardDataDays({ ...payload, sample: { ...payload.sample, days: 7 } })).toBe(7);
    expect(cardDataDays({ ...payload, sample: { ...payload.sample, days: 7, dataDays: 5 } })).toBe(5);
  });
  it("the card uses the volume-window length, so a 7-day window with 5 traded days still shows a 7-day APR", () => {
    const payload = fresh(payloadFixture());
    payload.sample = { ...payload.sample, days: 7, dataDays: 5 };
    expect(cardWindowDays(payload)).toBe(7);
    expect(summarizeApr7d(payload, "raydium-clmm", NOW)).toMatchObject({ status: "ready", days: 7, aprPct: expect.any(Number) });
  });
});

describe("rankGroupLookup", () => {
  it("has no New pool group: short-window and too-new pools rank like anyone else; Not supported yet still wins", () => {
    const pool = (key: string, over: Partial<UnifiedPool> = {}) => ({ key, tvlUsd: 20_000, ...over }) as UnifiedPool;
    const group = rankGroupLookup();
    expect(group(pool("a"))).toBe(0);
    expect(group(pool("b"))).toBe(0);
    expect(group(pool("b", { tvlUsd: 4_999 }))).toBe(1);
    expect(group(pool("a", { unsupportedIssues: ["ScaledUiAmount multiplier not 1"] }))).toBe(2);
  });
});
