/** Small deterministic payload for tests: flat liquidity, all volume in the current bin, spacing 1. */
import { estimateRangeApr } from "./range-apr";
import { toRangeAprInputs } from "./selection";
import type { PoolRangeAprPayload } from "./types";

export function payloadFixture(overrides: Partial<PoolRangeAprPayload> = {}): PoolRangeAprPayload {
  const bins = Array.from({ length: 21 }, (_, index) => ({ tick: index - 10, liquidity: 1e9, volumeUsd: index === 10 ? 1000 : 0 }));
  const model = { bins, currentSqrt: 1, usdPerRawB: 1, avgDailyVolumeUsd: 1000 };
  const pool = { tickSpacing: 1, tickCurrent: 0, currentPrice: 1, decimalsA: 6, decimalsB: 6, feeRate: 0.0005, lpFeeFraction: 0.84, tvlUsd: 1e6 };
  const inputs = { ...toRangeAprInputs({ pool, model, referenceCapitalUsd: 100 } as PoolRangeAprPayload) };
  const preset = (id: "ai" | "tight" | "standard" | "wide", tickLower: number, tickUpper: number) => ({
    id, tickLower, tickUpper, priceLower: 0, priceUpper: 0, estimate: estimateRangeApr(inputs, { tickLower, tickUpper }),
  });
  return {
    poolId: "pool", fetchedAt: "2026-10-11T00:00:00.000Z", label: "Est. fee APR", assumptions: "", pool, model,
    sample: { days: 7, volumeSource: "geckoterminal-daily", occupancySource: "hourly-candles", candleCount: 100, unplacedVolumePct: 0, confidence: "ok" },
    referenceCapitalUsd: 100,
    presets: [preset("ai", -2, 2), preset("tight", -3, 3), preset("standard", -6, 6), preset("wide", -9, 9)],
    sources: [], published: { dayFeeApr: null, weekFeeApr: null },
    ...overrides,
  };
}
