/**
 * One pool list for `/app/rwa-pairs` across chains (pure; no fetching here).
 *
 * Solana rows (Raydium CLMM, plus Orca / Meteora when their discovery flag is on) and Robinhood Chain Uniswap v4
 * rows share one shape so search, filters, sorting and "Hide duplicate pools" work the same for every card and row.
 *
 * Duplicate rule (PM / LJ 2026-10-30): on the same chain, pools of the same token pair (order-insensitive, by mint /
 * token address) collapse to the one with the highest estimated 7-day range APR; there is no TVL threshold, and pools
 * on different chains are never merged. A pool without a 7-day APR (not published for its protocol, still loading, or
 * unavailable) ranks below every pool that has one; between pools that both lack it, the higher TVL wins, then the
 * higher 24h volume, then the pool address (so the choice is stable).
 */

export type PoolChain = "solana" | "robinhood";
export type UnifiedProtocol = "raydium-clmm" | "orca-whirlpool" | "meteora-dlmm" | "uniswap-v4-rhc";
export type RiskFlag = "freeze" | "token-2022" | "pool-warning";

export const CHAIN_LABELS: Readonly<Record<PoolChain, string>> = { solana: "Solana", robinhood: "Robinhood Chain" };
export const PROTOCOL_LABELS: Readonly<Record<UnifiedProtocol, string>> = {
  "raydium-clmm": "Raydium",
  "orca-whirlpool": "Orca",
  "meteora-dlmm": "Meteora",
  "uniswap-v4-rhc": "Uniswap v4",
};
export const RISK_LABELS: Readonly<Record<RiskFlag, string>> = {
  freeze: "Freeze risk",
  "token-2022": "Token-2022",
  "pool-warning": "Pool warning",
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
  risks: RiskFlag[];
};

/** Estimated highest range APR (7-day average), percent; null when the pool has none (yet). */
export type Apr7dLookup = (pool: UnifiedPool) => number | null;

/** Same-pair key on one chain: mints sorted, so A/B and B/A match. EVM addresses are case-insensitive; Solana mints are not. */
export function samePairKey(pool: Pick<UnifiedPool, "chain" | "mintA" | "mintB">): string {
  const norm = (mint: string) => (pool.chain === "robinhood" ? mint.toLowerCase() : mint);
  const [a, b] = [norm(pool.mintA), norm(pool.mintB)].sort();
  return `${pool.chain}:${a}|${b}`;
}

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

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

/** Keeps one pool per (chain, token pair): the best by `compareDuplicateRank`. Input order is preserved. */
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

export type RiskFilter = "all" | "none" | RiskFlag;
export type PoolFilters = {
  query: string;
  chain: PoolChain | "all";
  protocol: UnifiedProtocol | "all";
  risk: RiskFilter;
  /** Minimum TVL in USD; null = any TVL. Applied before duplicate hiding (see `selectPools`). */
  minTvl: number | null;
};
export const DEFAULT_FILTERS: PoolFilters = { query: "", chain: "all", protocol: "all", risk: "all", minTvl: null };

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
    if (filters.risk === "none" && pool.risks.length > 0) return false;
    if (filters.risk !== "all" && filters.risk !== "none" && !pool.risks.includes(filters.risk)) return false;
    if (!words.length) return true;
    const haystack = [pool.pairLabel, pool.symbolA, pool.symbolB, pool.nameA, pool.nameB].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export type SortKey = "apr7d" | "apr24h" | "tvl" | "volume" | "name" | "chain" | "protocol" | "risk";
export type SortDir = "asc" | "desc";
export const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: "apr7d", dir: "desc" };
/** Direction a column sorts in on its first click: numbers high→low, text A→Z, risk fewest flags first. */
export const FIRST_CLICK_DIR: Readonly<Record<SortKey, SortDir>> = {
  apr7d: "desc", apr24h: "desc", tvl: "desc", volume: "desc", name: "asc", chain: "asc", protocol: "asc", risk: "asc",
};

function sortValue(pool: UnifiedPool, key: SortKey, apr7d: Apr7dLookup): number | string | null {
  switch (key) {
    case "apr7d": return apr7d(pool);
    case "apr24h": return pool.poolFeeApr24hPct;
    case "tvl": return pool.tvlUsd;
    case "volume": return pool.volume24hUsd;
    case "name": return pool.pairLabel.toLowerCase();
    case "chain": return CHAIN_LABELS[pool.chain];
    case "protocol": return PROTOCOL_LABELS[pool.protocol];
    case "risk": return pool.risks.length;
  }
}

/** Stable sort; missing numbers always go last whatever the direction; ties fall back to TVL (high first), then name. */
export function sortPools(pools: readonly UnifiedPool[], key: SortKey, dir: SortDir, apr7d: Apr7dLookup): UnifiedPool[] {
  const sign = dir === "asc" ? 1 : -1;
  return pools
    .map((pool, index) => ({ pool, index, value: sortValue(pool, key, apr7d) }))
    .sort((x, y) => {
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
 * - Search and the chain / protocol / risk filters come after: duplicates are decided over the whole (TVL-eligible)
 *   list, so those filters never promote a pool that lost to a hidden one.
 */
export function selectPools(pools: readonly UnifiedPool[], options: {
  filters: PoolFilters; hideDuplicates: boolean; sort: { key: SortKey; dir: SortDir }; apr7d: Apr7dLookup;
}): { pools: UnifiedPool[]; hiddenDuplicates: number } {
  const minTvl = options.filters.minTvl ?? null;
  const eligible = minTvl === null ? [...pools] : pools.filter((pool) => meetsMinTvl(pool, minTvl));
  const deduped = options.hideDuplicates ? hideDuplicatePools(eligible, options.apr7d) : eligible;
  const visible = filterPools(deduped, options.filters);
  const hiddenDuplicates = options.hideDuplicates ? filterPools(eligible, options.filters).length - visible.length : 0;
  return { pools: sortPools(visible, options.sort.key, options.sort.dir, options.apr7d), hiddenDuplicates };
}
