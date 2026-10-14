import { VOLUME_DIVERGENCE_THRESHOLD, volumeDivergenceSentence } from "./copy";

/** vol24h / avg7d, or null when either input is missing, non-finite or non-positive. */
export function volumeRatio(volume24hUsd: number | null | undefined, avgDailyVolume7dUsd: number | null | undefined): number | null {
  if (volume24hUsd === null || volume24hUsd === undefined || avgDailyVolume7dUsd === null || avgDailyVolume7dUsd === undefined) return null;
  if (!Number.isFinite(volume24hUsd) || !Number.isFinite(avgDailyVolume7dUsd)) return null;
  if (volume24hUsd < 0 || avgDailyVolume7dUsd <= 0) return null;
  return volume24hUsd / avgDailyVolume7dUsd;
}

/** Note to append to APR tooltips when today's volume diverges from the 7-day average by more than the threshold. */
export function volumeDivergenceNote(
  volume24hUsd: number | null | undefined,
  avgDailyVolume7dUsd: number | null | undefined,
  threshold = VOLUME_DIVERGENCE_THRESHOLD,
): string | null {
  const ratio = volumeRatio(volume24hUsd, avgDailyVolume7dUsd);
  if (ratio === null) return null;
  if (ratio > threshold) return volumeDivergenceSentence(ratio.toFixed(1), "hot");
  if (ratio < 1 / threshold) return volumeDivergenceSentence(ratio.toFixed(1), "cold");
  return null;
}
