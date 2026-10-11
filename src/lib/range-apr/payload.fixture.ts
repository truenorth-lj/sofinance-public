/** Small deterministic payload for tests: flat liquidity, all volume in the current bin, spacing 1. */
import { estimateRangeApr } from "./range-apr";
import { toRangeAprInputs } from "./selection";
import type { PoolRangeAprPayload, RangeAprPresetId } from "./types";

export function payloadFixture(overrides: Partial<PoolRangeAprPayload> = {}): PoolRangeAprPayload {
  const bins = Array.from({ length: 21 }, (_, index) => ({ tick: index - 10, liquidity: 1e9, volumeUsd: index === 10 ? 1000 : 0 }));
  const model = { bins, currentSqrt: 1, usdPerRawB: 1, avgDailyVolumeUsd: 1000 };
  const pool = { tickSpacing: 1, tickCurrent: 0, currentPrice: 1, decimalsA: 6, decimalsB: 6, feeRate: 0.0005, lpFeeFraction: 0.84, tvlUsd: 1e6 };
  const inputs = { ...toRangeAprInputs({ pool, model, referenceCapitalUsd: 100 } as PoolRangeAprPayload) };
  const preset = (id: "micro" | "tight" | "standard" | "wide", tickLower: number, tickUpper: number) => ({
    id, tickLower, tickUpper, priceLower: 0, priceUpper: 0, estimate: estimateRangeApr(inputs, { tickLower, tickUpper }),
  });
  return {
    poolId: "pool", fetchedAt: "2026-10-11T00:00:00.000Z", label: "Est. fee APR", assumptions: "", pool, model,
    sample: { days: 7, volumeSource: "geckoterminal-daily", occupancySource: "hourly-candles", candleCount: 100, unplacedVolumePct: 0, confidence: "ok", degraded: false, issues: [] },
    referenceCapitalUsd: 100,
    presets: [preset("micro", -2, 2), preset("tight", -3, 3), preset("standard", -6, 6), preset("wide", -9, 9)],
    sources: [], published: { dayFeeApr: null, weekFeeApr: null },
    ...overrides,
  };
}

/**
 * Fixture whose candidate estimates are set directly (APR percent, or null = unavailable), optionally with
 * explicit ticks, to exercise ranking / tie / dedupe logic without depending on the APR maths.
 */
export function payloadWithAprs(
  aprs: Partial<Record<RangeAprPresetId, number | null>>,
  ticks: Partial<Record<RangeAprPresetId, [number, number]>> = {},
): PoolRangeAprPayload {
  const base = payloadFixture();
  return {
    ...base,
    presets: base.presets.map((preset) => {
      const apr = aprs[preset.id];
      const [tickLower, tickUpper] = ticks[preset.id] ?? [preset.tickLower, preset.tickUpper];
      const estimate = apr === undefined
        ? preset.estimate
        : apr === null
          ? { status: "unavailable" as const, reason: "range-outside-window" as const }
          : { status: "ok" as const, aprPct: apr, inRangeVolumePct: 100, feesPerDayUsd: 1 };
      return { ...preset, tickLower, tickUpper, estimate };
    }),
  };
}

/** A payload as the server ships it when price history was unavailable: ranges resolved, no estimates. */
export function degradedPayloadFixture(): PoolRangeAprPayload {
  const base = payloadFixture();
  return {
    ...base,
    sample: {
      ...base.sample, occupancySource: "current-price", volumeSource: "raydium-7d", candleCount: 0, confidence: "low",
      degraded: true, issues: ["GeckoTerminal hourly candles: Upstream request failed (429)"],
    },
    presets: base.presets.map((preset) => ({ ...preset, estimate: { status: "unavailable", reason: "degraded-data" } })),
  };
}
