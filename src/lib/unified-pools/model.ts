/**
 * One pool list for `/app/rwa-pairs` across chains (pure; no fetching here).
 *
 * Solana rows (Raydium CLMM, plus Orca / Meteora when their discovery flag is on) and Robinhood Chain Uniswap v4
 * rows share one shape so search, filters, sorting and "Hide duplicate pools" work the same for every card and row.
 *
 * Duplicate rule (PM / LJ 2026-10-30; same-protocol scope: PM 2026-11-01): on the same chain and protocol, pools of the
 * same token pair (order-insensitive, by mint / token address) collapse to the one with the highest estimated 7-day
 * range APR; there is no TVL threshold. Pools on different chains or protocols are never merged: the same pair on
 * Raydium and Meteora is two rows, told apart by their protocol badge. A pool without a 7-day APR (not published for its protocol, still loading, or
 * unavailable) ranks below every pool that has one; between pools that both lack it, the higher TVL wins, then the
 * higher 24h volume, then the pool address (so the choice is stable).
 */

export type PoolChain = "solana" | "robinhood";
export type UnifiedProtocol = "raydium-clmm" | "orca-whirlpool" | "meteora-dlmm" | "uniswap-v4-rhc";

export const CHAIN_LABELS: Readonly<Record<PoolChain, string>> = { solana: "Solana", robinhood: "Robinhood Chain" };
export const PROTOCOL_LABELS: Readonly<Record<UnifiedProtocol, string>> = {
  "raydium-clmm": "Raydium",
  "orca-whirlpool": "Orca",
  "meteora-dlmm": "Meteora",
  "uniswap-v4-rhc": "Uniswap v4",
};

export type UnifiedPool = {
  /** `${chain}:${poolAddress}`; unique across the list. */
  key: string;
  chain: PoolChain;
  protocol: UnifiedProtocol;
  poolAddress: string;
  /** Display name, wrapped side first (e.g. "SPCXx/SPCX"). */
  pairLabel: string;
  symbolA: string;
  symbolB: string;
  nameA: string;
  nameB: string;
  mintA: string;
  mintB: string;
  feeTierBps: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  /** Estimated pool fee APR from the last 24h, percent. */
  poolFeeApr24hPct: number | null;
  /**
   * Settings of the pool's tokens that opening does not handle yet (the engine's `poolMintIssues`, e.g. "ScaledUiAmount
   * multiplier not 1" when the multiplier is outside `SCALED_UI_MULTIPLIER_TOLERANCE` of 1); absent or empty when it
   * can be opened. Such a pool shows "Not supported yet" instead of Open.
   */
  unsupportedIssues?: readonly string[];
};

/** Estimated highest range APR (7-day average), percent; null when the pool has none (yet). */
export type Apr7dLookup = (pool: UnifiedPool) => number | null;

/**
 * Same-pair key on one chain and protocol: mints sorted, so A/B and B/A match. EVM addresses are case-insensitive;
 * Solana mints are not.
 */
export function samePairKey(pool: Pick<UnifiedPool, "chain" | "protocol" | "mintA" | "mintB">): string {
  const norm = (mint: string) => (pool.chain === "robinhood" ? mint.toLowerCase() : mint);
  const [a, b] = [norm(pool.mintA), norm(pool.mintB)].sort();
  return `${pool.chain}:${pool.protocol}:${a}|${b}`;
}

/** Shown (on a greyed Open button) where the list cannot open a position in the pool's protocol. */
const METEORA_OPEN_UNAVAILABLE = "Opening Meteora positions isn't available yet";

/** Why the list cannot open this pool, or null when it can (Meteora DLMM: not from the list, PM 2026-11-01). */
export function openUnavailableReason(pool: Pick<UnifiedPool, "protocol">): string | null {
  return pool.protocol === "meteora-dlmm" ? METEORA_OPEN_UNAVAILABLE : null;
}

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/** Pools under this TVL (USD) show a "Low TVL" tag and rank below every bigger pool by APR (also the homepage floor). */
export const LOW_TVL_USD = 5_000;
export const LOW_TVL_LABEL = "Low TVL";
/** Shown in place of Open for a pool whose tokens use a setting opening does not handle yet. */
export const NOT_SUPPORTED_LABEL = "Not supported yet";

export function isLowTvl(pool: Pick<UnifiedPool, "tvlUsd">): boolean {
  return finite(pool.tvlUsd) && pool.tvlUsd < LOW_TVL_USD;
}

/** Plain-language reason a pool's tokens cannot be opened yet (tooltip of "Not supported yet"), or null when they can. */
export function unsupportedTokenReason(pool: Pick<UnifiedPool, "unsupportedIssues">): string | null {
  const issues = pool.unsupportedIssues ?? [];
  if (!issues.length) return null;
  if (issues.some((issue) => issue.startsWith("ScaledUiAmount"))) return "This token uses a balance multiplier, which we don't support yet.";
  if (issues.some((issue) => issue.startsWith("TransferHook"))) return "This token runs extra checks on every transfer, which we don't support yet.";
  return "This token uses a setting we don't support yet.";
}

/**
 * Where a pool ranks by APR, before its APR: 0 normal, 1 Low TVL (under `LOW_TVL_USD`), 2 New pool (too few days of
 * data), 3 Not supported yet. Higher groups always come after lower ones, in either APR direction.
 */
export type RankGroup = 0 | 1 | 2 | 3;
export type RankGroupLookup = (pool: UnifiedPool) => RankGroup;

export function poolRankGroup(pool: UnifiedPool, isNewPool: boolean): RankGroup {
  if (unsupportedTokenReason(pool)) return 3;
  if (isNewPool) return 2;
  return isLowTvl(pool) ? 1 : 0;
}

/** Rank groups without APR states (new pools unknown): Not supported yet, then Low TVL. */
export const poolRankGroupOf: RankGroupLookup = (pool) => poolRankGroup(pool, false);

/** Negative when `a` should be kept over `b` (higher 7d APR; no 7d APR ranks last; then TVL, 24h volume, address). */
export function compareDuplicateRank(a: UnifiedPool, b: UnifiedPool, apr7d: Apr7dLookup): number {
  const aprA = apr7d(a), aprB = apr7d(b);
  if (finite(aprA) !== finite(aprB)) return finite(aprA) ? -1 : 1;
  if (finite(aprA) && finite(aprB) && aprA !== aprB) return aprB - aprA;
  const tvlA = finite(a.tvlUsd) ? a.tvlUsd : -1, tvlB = finite(b.tvlUsd) ? b.tvlUsd : -1;
  if (tvlA !== tvlB) return tvlB - tvlA;
  const volA = finite(a.volume24hUsd) ? a.volume24hUsd : -1, volB = finite(b.volume24hUsd) ? b.volume24hUsd : -1;
  if (volA !== volB) return volB - volA;
  return a.poolAddress < b.poolAddress ? -1 : a.poolAddress > b.poolAddress ? 1 : 0;
}

/** Keeps one pool per (chain, protocol, token pair): the best by `compareDuplicateRank`. Input order is preserved. */
export function hideDuplicatePools(pools: readonly UnifiedPool[], apr7d: Apr7dLookup): UnifiedPool[] {
  const best = new Map<string, UnifiedPool>();
  for (const pool of pools) {
    const key = samePairKey(pool);
    const current = best.get(key);
    if (!current || compareDuplicateRank(pool, current, apr7d) < 0) best.set(key, pool);
  }
  const kept = new Set([...best.values()].map((pool) => pool.key));
  return pools.filter((pool) => kept.has(pool.key));
}

export type PoolFilters = {
  query: string;
  chain: PoolChain | "all";
  protocol: UnifiedProtocol | "all";
  /** Minimum TVL in USD; null = any TVL. Applied before duplicate hiding (see `selectPools`). */
  minTvl: number | null;
};
export const DEFAULT_FILTERS: PoolFilters = { query: "", chain: "all", protocol: "all", minTvl: null };

/** `/app/rwa-pairs` TVL filter presets (USD), next to "Any" and a custom amount (LJ, 2026-10-31). */
export const TVL_FILTER_PRESETS = [5_000, 10_000, 50_000] as const;

/** Whether a pool passes a minimum-TVL filter (null = any TVL; a pool with unknown TVL fails any minimum). */
export function meetsMinTvl(pool: Pick<UnifiedPool, "tvlUsd">, minTvl: number | null): boolean {
  if (minTvl === null) return true;
  return finite(pool.tvlUsd) && pool.tvlUsd >= minTvl;
}

/** Search matches token symbols, token names and the pair label (case-insensitive, every word must match). */
export function filterPools(pools: readonly UnifiedPool[], filters: PoolFilters): UnifiedPool[] {
  const words = filters.query.trim().toLowerCase().split(/[\s/]+/).filter(Boolean);
  return pools.filter((pool) => {
    if (filters.chain !== "all" && pool.chain !== filters.chain) return false;
    if (filters.protocol !== "all" && pool.protocol !== filters.protocol) return false;
    if (!words.length) return true;
    const haystack = [pool.pairLabel, pool.symbolA, pool.symbolB, pool.nameA, pool.nameB].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export type SortKey = "apr7d" | "tvl" | "volume" | "name" | "chain" | "protocol";
export type SortDir = "asc" | "desc";
export const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: "apr7d", dir: "desc" };
/** Direction a column sorts in on its first click: numbers high→low, text A→Z. */
export const FIRST_CLICK_DIR: Readonly<Record<SortKey, SortDir>> = {
  apr7d: "desc", tvl: "desc", volume: "desc", name: "asc", chain: "asc", protocol: "asc",
};

function sortValue(pool: UnifiedPool, key: SortKey, apr7d: Apr7dLookup): number | string | null {
  switch (key) {
    case "apr7d": return apr7d(pool);
    case "tvl": return pool.tvlUsd;
    case "volume": return pool.volume24hUsd;
    case "name": return pool.pairLabel.toLowerCase();
    case "chain": return CHAIN_LABELS[pool.chain];
    case "protocol": return PROTOCOL_LABELS[pool.protocol];
  }
}

/**
 * Stable sort; missing numbers always go last whatever the direction; ties fall back to TVL (high first), then name.
 * By APR, rank groups come first in either direction (`RankGroup`: normal, Low TVL, New pool, Not supported yet).
 */
export function sortPools(pools: readonly UnifiedPool[], key: SortKey, dir: SortDir, apr7d: Apr7dLookup, group: RankGroupLookup = poolRankGroupOf): UnifiedPool[] {
  const sign = dir === "asc" ? 1 : -1;
  return pools
    .map((pool, index) => ({ pool, index, value: sortValue(pool, key, apr7d), group: key === "apr7d" ? group(pool) : 0 }))
    .sort((x, y) => {
      if (x.group !== y.group) return x.group - y.group;
      const missingX = x.value === null || (typeof x.value === "number" && !Number.isFinite(x.value));
      const missingY = y.value === null || (typeof y.value === "number" && !Number.isFinite(y.value));
      if (missingX !== missingY) return missingX ? 1 : -1;
      if (!missingX && x.value !== y.value) {
        const cmp = typeof x.value === "number" && typeof y.value === "number"
          ? x.value - y.value : String(x.value).localeCompare(String(y.value));
        if (cmp !== 0) return cmp * sign;
      }
      const tvl = (y.pool.tvlUsd ?? -1) - (x.pool.tvlUsd ?? -1);
      if (tvl !== 0) return tvl;
      return x.pool.pairLabel.localeCompare(y.pool.pairLabel) || x.index - y.index;
    })
    .map((entry) => entry.pool);
}

/**
 * TVL filter → optional duplicate hiding → search / other filters → sort. Returns the rows and how many duplicates
 * were hidden.
 * - The TVL minimum comes first (LJ, 2026-10-31): a pool below it never takes part in the duplicate rule, so a tiny
 *   pool with a higher 7-day APR cannot hide the bigger pool of the same pair.
 * - Search and the chain / protocol filters come after: duplicates are decided over the whole (TVL-eligible)
 *   list, so those filters never promote a pool that lost to a hidden one.
 */
export function selectPools(pools: readonly UnifiedPool[], options: {
  filters: PoolFilters; hideDuplicates: boolean; sort: { key: SortKey; dir: SortDir }; apr7d: Apr7dLookup;
  /** Rank groups (default: from the pool alone, `poolRankGroupOf`; pass one that knows new pools). */
  group?: RankGroupLookup;
}): { pools: UnifiedPool[]; hiddenDuplicates: number } {
  const group = options.group ?? poolRankGroupOf;
  const minTvl = options.filters.minTvl ?? null;
  const eligible = minTvl === null ? [...pools] : pools.filter((pool) => meetsMinTvl(pool, minTvl));
  const deduped = options.hideDuplicates ? hideDuplicatePools(eligible, options.apr7d) : eligible;
  const visible = filterPools(deduped, options.filters);
  const hiddenDuplicates = options.hideDuplicates ? filterPools(eligible, options.filters).length - visible.length : 0;
  return { pools: sortPools(visible, options.sort.key, options.sort.dir, options.apr7d, group), hiddenDuplicates };
}
