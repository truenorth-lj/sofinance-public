export const HOMEPAGE_POOL_LIMIT = 6;
/** Tiny pools can print 100%+ est. APR; keep them off the homepage headline when larger ones exist. */
export const HOMEPAGE_TVL_FLOOR_USD = 10_000;

export type HomepagePool = {
  poolAddress: string;
  wrappedSymbol: string;
  plainSymbol: string;
  feeTierBps: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  estimatedFeeAprPct: number | null;
  freezeRisk: boolean;
  token2022A: boolean;
  token2022B: boolean;
};

export function sortPoolsByTvl<T extends { tvlUsd: number | null }>(pairs: readonly T[]): T[] {
  return [...pairs].sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1));
}

/**
 * Homepage rows: TVL descending, drop sub-floor pools when anything qualifies, cap at
 * HOMEPAGE_POOL_LIMIT. If a tweet deep-link pool is missing from that set, swap it in.
 */
export function selectHomepagePools<T extends { tvlUsd: number | null; poolAddress: string }>(
  pairs: readonly T[],
  highlightPool?: string,
): T[] {
  const sorted = sortPoolsByTvl(pairs);
  const aboveFloor = sorted.filter((row) => (row.tvlUsd ?? 0) >= HOMEPAGE_TVL_FLOOR_USD);
  const ranked = aboveFloor.length > 0 ? aboveFloor : sorted;
  const picked = ranked.slice(0, HOMEPAGE_POOL_LIMIT);
  const highlight = highlightPool?.trim();
  if (!highlight || picked.some((row) => row.poolAddress === highlight)) return picked;
  const extra = sorted.find((row) => row.poolAddress === highlight);
  if (!extra) return picked;
  return [...picked.slice(0, Math.max(HOMEPAGE_POOL_LIMIT - 1, 0)), extra];
}

export function formatUsd(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(digits)}`;
}

export function formatAprPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
}

export function freshnessLabel(snapshotAt: string, now: number): string {
  const ageMs = now - Date.parse(snapshotAt);
  if (!Number.isFinite(ageMs)) return "Updated just now";
  const mins = Math.max(0, Math.round(ageMs / 60_000));
  if (mins < 1) return "Updated just now";
  if (mins === 1) return "Updated 1 min ago";
  if (mins < 60) return `Updated ${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? "Updated 1h ago" : `Updated ${hours}h ago`;
}
