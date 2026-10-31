import type { TokenIconMap } from "@/lib/token-icons/map";
import type { SnapshotSourceTime as HomepageSourceTime } from "@/lib/snapshot-updated";
import { DEFAULT_FILTERS, DEFAULT_SORT, selectPools, type Apr7dLookup, type PoolChain, type UnifiedPool } from "@/lib/unified-pools/model";
import { rhcPool, solanaPool, type RhcPoolSummary, type SolanaPoolRow } from "@/lib/unified-pools/rows";

/** The homepage shows the top pools of `/app/rwa-pairs` (LJ, 2026-10-31: at most 5), with a "View all pools" link. */
export const HOMEPAGE_POOL_LIMIT = 5;

/** A Solana row from `/api/rwa-pairs` (or its saved snapshot). */
export type HomepageSolanaRow = SolanaPoolRow & { wrapKind?: string };

/** One homepage row: the `/app/rwa-pairs` pool shape (either chain), built by the same `solanaPool` / `rhcPool`. */
export type HomepagePool = UnifiedPool;

export { updatedLabel, utcMinuteLabel, type SnapshotSourceTime as HomepageSourceTime } from "@/lib/snapshot-updated";

/**
 * Server snapshot for the homepage table. `pools` are all candidate pools of both chains (before the duplicate rule),
 * `apr7d` the estimated highest range APR (7-day) per pool key from the same saved APR snapshots `/app/rwa-pairs`
 * reads (Solana: the 7-day range backtest; Robinhood Chain: Est. APR · 7d), so the server HTML lists the same top
 * pools as `/app/rwa-pairs`; `homepageRows` picks them.
 */
export type HomepagePoolsSnapshot = {
  pools: HomepagePool[];
  apr7d: Record<string, number>;
  tokenIcons?: TokenIconMap;
  updated: HomepageSourceTime[];
};

/** Both chains' candidate pools in one list, exactly as `/app/rwa-pairs` builds them (each pool once). */
export function buildHomepagePools(input: {
  solana?: readonly HomepageSolanaRow[] | null;
  rhc?: readonly RhcPoolSummary[] | null;
}): HomepagePool[] {
  const seen = new Set<string>();
  return [
    ...(input.solana ?? []).map(solanaPool),
    ...(input.rhc ?? []).map(rhcPool).filter((pool): pool is HomepagePool => pool !== null),
  ].filter((pool) => (seen.has(pool.key) ? false : (seen.add(pool.key), true)));
}

/** `/app/rwa-pairs`'s default view: no filters, "Hide duplicate pools" on, sorted by Est. APR · 7d (high to low). */
export const RWA_PAIRS_DEFAULT_SELECT = { filters: DEFAULT_FILTERS, hideDuplicates: true, sort: DEFAULT_SORT } as const;

/**
 * Every pool in `/app/rwa-pairs`'s default order, through the same `selectPools`: one pool per chain and token pair
 * (LJ's rule: the highest estimated 7-day APR wins), both chains merged, by 7-day APR from high to low (pools without
 * one last, ties by TVL).
 */
export function rwaPairsDefaultOrder<T extends UnifiedPool>(pools: readonly T[], apr7d: Apr7dLookup): T[] {
  return selectPools(pools, { ...RWA_PAIRS_DEFAULT_SELECT, apr7d }).pools as T[];
}

const samePool = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();

/**
 * Homepage rows: the first HOMEPAGE_POOL_LIMIT pools of `/app/rwa-pairs`'s default view. If a shared link's pool
 * (`?pool=`) is listed there but not in the top rows, it takes the last slot.
 */
export function homepageRows<T extends UnifiedPool>(pools: readonly T[], apr7d: Apr7dLookup, highlightPool?: string): T[] {
  const ranked = rwaPairsDefaultOrder(pools, apr7d);
  const top = ranked.slice(0, HOMEPAGE_POOL_LIMIT);
  const highlight = highlightPool?.trim();
  if (!highlight || top.some((pool) => samePool(pool.poolAddress, highlight))) return top;
  const extra = ranked.find((pool) => samePool(pool.poolAddress, highlight));
  return extra ? [...ranked.slice(0, Math.max(HOMEPAGE_POOL_LIMIT - 1, 0)), extra] : top;
}

/** `Apr7dLookup` over a `{ poolKey: aprPct }` record (missing key → no 7-day APR). */
export const aprLookupFrom = (apr7d: Readonly<Record<string, number>>): Apr7dLookup =>
  (pool) => (Number.isFinite(apr7d[pool.key]) ? apr7d[pool.key]! : null);

/**
 * Server snapshot for the homepage table: every candidate pool (both chains), their 7-day APRs, only the icons those
 * pools use, and when each chain's saved list was written.
 */
export function toHomepagePoolsSnapshot(input: {
  solana?: { pairs: readonly HomepageSolanaRow[]; tokenIcons?: TokenIconMap; fetchedAt: string; stale: boolean } | null;
  rhc?: { pools: readonly RhcPoolSummary[]; fetchedAt: string; stale: boolean } | null;
  apr7d?: Readonly<Record<string, number>>;
}): HomepagePoolsSnapshot {
  const pools = buildHomepagePools({ solana: input.solana?.pairs, rhc: input.rhc?.pools });
  const keys = new Set(pools.map((pool) => pool.key));
  const apr7d = Object.fromEntries(Object.entries(input.apr7d ?? {}).filter(([key, value]) => keys.has(key) && Number.isFinite(value)));
  const mints = (chain: PoolChain) => new Set(pools.filter((row) => row.chain === chain)
    .flatMap((row) => [row.mintA, row.mintB].map((mint) => (chain === "robinhood" ? mint.toLowerCase() : mint))));
  const icons = input.solana?.tokenIcons;
  const solanaMints = mints("solana"), rhcMints = mints("robinhood");
  const tokenIcons = icons
    ? {
        solana: Object.fromEntries(Object.entries(icons.solana ?? {}).filter(([mint]) => solanaMints.has(mint))),
        robinhood: Object.fromEntries(Object.entries(icons.robinhood ?? {}).filter(([address]) => rhcMints.has(address.toLowerCase()))),
      }
    : undefined;
  const updated: HomepageSourceTime[] = [];
  if (input.solana) updated.push({ chain: "solana", fetchedAt: input.solana.fetchedAt, stale: input.solana.stale });
  if (input.rhc) updated.push({ chain: "robinhood", fetchedAt: input.rhc.fetchedAt, stale: input.rhc.stale });
  return { pools, apr7d, tokenIcons, updated };
}

/** The `/app/rwa-pairs` APR formatter: "—" when missing, "<0.01%" for a real but tiny APR, otherwise two decimals. */
export { formatAprPct, exactAprTitle } from "@/lib/apr-labels/format-apr";
