import type { TokenIconMap } from "@/lib/token-icons/map";
import type { SnapshotSourceTime as HomepageSourceTime } from "@/lib/snapshot-updated";
import { DEFAULT_FILTERS, selectPools, type Apr7dLookup, type PoolChain, type UnifiedPool } from "@/lib/unified-pools/model";
import { rhcPool, solanaPool, type RhcPoolSummary, type SolanaPoolRow } from "@/lib/unified-pools/rows";

/**
 * Same-stock pools shown on the homepage (both chains together). Today that is every Robinhood Chain StablePair pool
 * (11) plus the Solana pairs above the TVL floor, so nothing is clipped; the cap only guards against a much longer list.
 */
export const HOMEPAGE_POOL_LIMIT = 16;
/** Tiny pools can print 100%+ est. APR; keep them off the homepage headline when larger ones exist. */
export const HOMEPAGE_TVL_FLOOR_USD = 10_000;

/** A Solana row from `/api/rwa-pairs` (or its saved snapshot). `wrapKind: "stable"` marks the curated USDC/USDT pool. */
export type HomepageSolanaRow = SolanaPoolRow & { wrapKind?: string };

/**
 * One homepage row, either chain: the `/app/rwa-pairs` pool shape (chain, protocol, pair label, risks) plus the icon
 * order and whether both sides are the same stock. The curated stablecoin pool (USDC/USDT) is not, so it is listed last.
 */
export type HomepagePool = UnifiedPool & { wrappedSymbol: string; plainSymbol: string; sameAsset: boolean };

export { updatedLabel, utcMinuteLabel, type SnapshotSourceTime as HomepageSourceTime } from "@/lib/snapshot-updated";

/**
 * Server snapshot for the homepage table. `pools` are all candidate pools of both chains (before the duplicate rule),
 * `apr7d` the estimated highest range APR (7-day) per pool key from the same saved APR snapshots `/app/rwa-pairs`
 * reads, so the server picks the same pool per pair as `/app/rwa-pairs` does; `homepageRows` turns them into rows.
 */
export type HomepagePoolsSnapshot = {
  pools: HomepagePool[];
  apr7d: Record<string, number>;
  tokenIcons?: TokenIconMap;
  updated: HomepageSourceTime[];
};

export function homepageSolanaPool(row: HomepageSolanaRow): HomepagePool {
  return { ...solanaPool(row), wrappedSymbol: row.wrappedSymbol, plainSymbol: row.plainSymbol, sameAsset: row.wrapKind !== "stable" };
}

/** Robinhood Chain StablePair pool (Robinhood token / Ondo token of one stock); null when not listed (same rule as `/app/rwa-pairs`). */
export function homepageRhcPool(summary: RhcPoolSummary): HomepagePool | null {
  const pool = rhcPool(summary);
  if (!pool) return null;
  const [wrappedSymbol = pool.symbolA, plainSymbol = pool.symbolB] = pool.pairLabel.split("/");
  return { ...pool, wrappedSymbol, plainSymbol, sameAsset: true };
}

/** Both chains' candidate pools in one list (each pool once; the per-pair duplicate rule is applied by `homepageRows`). */
export function buildHomepagePools(input: {
  solana?: readonly HomepageSolanaRow[] | null;
  rhc?: readonly RhcPoolSummary[] | null;
}): HomepagePool[] {
  const seen = new Set<string>();
  return [
    ...(input.solana ?? []).map(homepageSolanaPool),
    ...(input.rhc ?? []).map(homepageRhcPool).filter((pool): pool is HomepagePool => pool !== null),
  ].filter((pool) => (seen.has(pool.key) ? false : (seen.add(pool.key), true)));
}

/** `/app/rwa-pairs`'s default view, sorted by TVL instead of 7-day APR. */
const HOMEPAGE_SELECT = { filters: DEFAULT_FILTERS, hideDuplicates: true, sort: { key: "tvl", dir: "desc" } } as const;

/**
 * One pool per chain and token pair, chosen exactly as `/app/rwa-pairs` chooses it (LJ's rule: the highest estimated
 * 7-day range APR; pools without one rank below, then TVL, 24h volume, address), through the same `selectPools`.
 */
export function dedupeLikeRwaPairs<T extends UnifiedPool>(pools: readonly T[], apr7d: Apr7dLookup): T[] {
  return selectPools(pools, { ...HOMEPAGE_SELECT, apr7d }).pools as T[];
}

/** Homepage rows: the `/app/rwa-pairs` duplicate rule, then the homepage's TVL ranking, floor, cap and stablecoin-last rule. */
export function homepageRows(pools: readonly HomepagePool[], apr7d: Apr7dLookup, highlightPool?: string): HomepagePool[] {
  return selectHomepagePools(dedupeLikeRwaPairs(pools, apr7d), highlightPool);
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

export function sortPoolsByTvl<T extends { tvlUsd: number | null }>(pairs: readonly T[]): T[] {
  return [...pairs].sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1));
}

const samePool = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();

/**
 * Homepage rows: same-stock pools by TVL descending (sub-floor pools dropped when anything qualifies, capped at
 * HOMEPAGE_POOL_LIMIT), then pools that are not same-stock pairs (the curated USDC/USDT pool) at the end. If a tweet
 * deep-link pool is missing from that set, swap it in.
 */
export function selectHomepagePools<T extends { tvlUsd: number | null; poolAddress: string; sameAsset?: boolean }>(
  pairs: readonly T[],
  highlightPool?: string,
): T[] {
  const sorted = sortPoolsByTvl(pairs);
  const sameAsset = sorted.filter((row) => row.sameAsset !== false);
  const others = sorted.filter((row) => row.sameAsset === false && (row.tvlUsd ?? 0) >= HOMEPAGE_TVL_FLOOR_USD);
  const aboveFloor = sameAsset.filter((row) => (row.tvlUsd ?? 0) >= HOMEPAGE_TVL_FLOOR_USD);
  const ranked = aboveFloor.length > 0 ? aboveFloor : sameAsset;
  const picked = [...ranked.slice(0, HOMEPAGE_POOL_LIMIT), ...others];
  const highlight = highlightPool?.trim();
  if (!highlight || picked.some((row) => samePool(row.poolAddress, highlight))) return picked;
  const extra = sorted.find((row) => samePool(row.poolAddress, highlight));
  if (!extra) return picked;
  return [...ranked.slice(0, Math.max(HOMEPAGE_POOL_LIMIT - 1, 0)), extra, ...others];
}

export function formatUsd(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(digits)}`;
}

/** The `/app/rwa-pairs` APR formatter: "—" when missing, "<0.01%" for a real but tiny APR, otherwise two decimals. */
export { formatAprPct, exactAprTitle } from "@/lib/apr-labels/format-apr";
