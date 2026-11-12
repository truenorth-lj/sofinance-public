"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { LoaderCircle, Search, X } from "lucide-react";
import { HIGHEST_RANGE_APR_7D_HELP, HOMEPAGE_APR_DOCS_LINK_LABEL } from "@/lib/apr-labels/copy";
import {
  buildHomepagePools,
  homepageRows,
  HOMEPAGE_MIN_TVL_USD,
  RWA_PAIRS_DEFAULT_SELECT,
  updatedLabel,
  type HomepagePool,
  type HomepagePoolsSnapshot,
  type HomepageSolanaRow,
  type HomepageSourceTime,
} from "@/lib/homepage-pools";
import { isRhcUniv4DiscoveryEnabled } from "@/lib/protocol-flags";
import { dexDescriptors, uiFor } from "@/lib/dex/client";
import { fetchRwaPairsList } from "@/lib/rwa-pairs-list";
import { APP_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import {
  CHAIN_LABELS, DEFAULT_SORT, FIRST_CLICK_DIR, PROTOCOL_LABELS, selectPools, unsupportedTokenReason,
  type PoolChain, type SortDir, type SortKey, type UnifiedPool,
} from "@/lib/unified-pools/model";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";
import { cn } from "@/lib/cn";
import { MarketCard, marketRow, marketRowsPanel, MarketRowsSkeleton } from "./stocks/stock-cards";
import { useFlipRows } from "./use-flip-rows";
import { PairTokenIcons } from "./pair-token-icons";
import { iconPair, money, pct, NEW_POOL_LABEL, PoolTable, type OpenAction } from "./unified-pools/pool-list";
import { usePoolsApr7d } from "./unified-pools/use-pools-apr7d";
import { rankGroupLookup } from "@/lib/unified-pools/apr7d";
import type { TokenIconMap } from "@/lib/token-icons/map";

type PairsResponse = {
  pairs?: HomepageSolanaRow[];
  tokenIcons?: TokenIconMap;
  fetchedAt?: string;
  freshness?: { snapshotAt: string; stale: boolean };
};
type RhcResponse = { pools?: RhcPoolSummary[]; fetchedAt?: string; snapshot?: { stale?: boolean } };

const RHC_POOLS_URL = "/api/protocol-pools?protocol=uniswap-v4-rhc";

/**
 * Where Open goes: the pool on `/app/rwa-pairs` with `?openPool=…`, which opens that pool's own flow there (Raydium:
 * Create position; Robinhood Chain and registry DEXes such as Meteora: their dialog).
 */
function openPoolHref(pool: Pick<HomepagePool, "poolAddress">) {
  return `${APP_ROUTES.rwaPairs}?openPool=${encodeURIComponent(pool.poolAddress)}`;
}

/**
 * Open as on `/app/rwa-pairs`: tokens not supported yet say so; a registry DEX (`openUi: "registry"`, today Meteora)
 * is disabled when its `open` capability is unsupported; every other pool is a deep link, and the app page uses the
 * same `openUi` path (native modal, RHC dialog, or not available). No DEX-name checks here.
 */
const openAction = (pool: UnifiedPool): OpenAction => {
  const unsupported = unsupportedTokenReason(pool);
  if (unsupported) return { kind: "unsupported", reason: unsupported };
  // Only a registry-dispatched Open (`openUi: "registry"`) consults `capabilities.open`. RHC
  // (`rhc-dialog`) and Raydium (`native-modal`) stay deep links even if a descriptor marks the
  // generic StepResult open path unsupported.
  if (uiFor(pool.protocol).openUi === "registry") {
    const open = dexDescriptors.descriptorFor(pool.protocol)?.capabilities.open;
    if (open && !open.supported) return { kind: "disabled", reason: open.reason };
  }
  return { kind: "link", href: openPoolHref(pool) };
};

type ChainPools = Partial<Record<PoolChain, HomepagePool[]>>;

function splitByChain(pools: readonly HomepagePool[] | undefined): ChainPools {
  const out: ChainPools = {};
  for (const pool of pools ?? []) (out[pool.chain] ??= []).push(pool);
  return out;
}

async function fetchRhcPools(signal?: AbortSignal): Promise<RhcResponse> {
  const response = await fetch(RHC_POOLS_URL, { signal, headers: { Accept: "application/json" } });
  const body = (await response.json()) as RhcResponse & { error?: string };
  if (!response.ok) throw new Error(body.error || "Failed to load Robinhood Chain pools");
  return body;
}

export type HomepagePoolsData = {
  /** Every pool of both chains (null until the first list arrives when there was no server snapshot). */
  pools: HomepagePool[] | null;
  apr: Readonly<Record<string, Apr7dState | undefined>>;
  /** The 7-day APR that ranks a pool: the client estimate once loaded, the server snapshot's until then. */
  apr7d: (pool: UnifiedPool) => number | null;
  group: ReturnType<typeof rankGroupLookup>;
  icons: TokenIconMap | undefined;
  updatedText: string | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
};

/**
 * The homepage's pools, for the Top Pools card and the full list. `initial` is the server snapshot (ISR) so the
 * prerendered HTML already lists the pools (ranked by the saved 7-day APRs) plus the "Updated … UTC" time of the saved
 * lists; after mount it refreshes from the CDN-cached `/api/rwa-pairs` and `/api/protocol-pools?protocol=uniswap-v4-rhc`.
 * A chain whose refresh fails keeps its server rows. Without a snapshot `pools` stays null until a fetch returns.
 */
export function useHomepagePools(initial?: HomepagePoolsSnapshot | null): HomepagePoolsData {
  const [byChain, setByChain] = useState<ChainPools | null>(() => (initial ? splitByChain(initial.pools) : null));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initial);
  const [icons, setIcons] = useState<TokenIconMap | undefined>(initial?.tokenIcons);
  const [updated, setUpdated] = useState<HomepageSourceTime[]>(initial?.updated ?? []);

  const hasRows = useRef(Boolean(initial?.pools.length));
  const load = useCallback(async (signal?: AbortSignal) => {
    const [solana, rhc] = await Promise.allSettled([
      fetchRwaPairsList<PairsResponse>(signal),
      isRhcUniv4DiscoveryEnabled() ? fetchRhcPools(signal) : Promise.reject(new Error("disabled")),
    ]);
    if (signal?.aborted) return;
    setLoading(false);
    if (solana.status === "rejected" && rhc.status === "rejected") {
      // Keep showing the server snapshot when the refresh fails; only an empty list shows the error.
      if (hasRows.current) return;
      const reason = solana.reason;
      setError(reason instanceof Error ? reason.message : "Failed to load pools");
      return;
    }
    const fresh = splitByChain(buildHomepagePools({
      solana: solana.status === "fulfilled" ? solana.value.pairs ?? [] : null,
      rhc: rhc.status === "fulfilled" ? rhc.value.pools ?? [] : null,
    }));
    setByChain((current) => {
      const next: ChainPools = { ...current };
      if (solana.status === "fulfilled") next.solana = fresh.solana ?? [];
      if (rhc.status === "fulfilled") next.robinhood = fresh.robinhood ?? [];
      hasRows.current = Boolean(next.solana?.length || next.robinhood?.length);
      return next;
    });
    if (solana.status === "fulfilled" && solana.value.tokenIcons) setIcons(solana.value.tokenIcons);
    setUpdated((current) => {
      const next = new Map(current.map((entry) => [entry.chain, entry]));
      if (solana.status === "fulfilled" && solana.value.fetchedAt)
        next.set("solana", { chain: "solana", fetchedAt: solana.value.fetchedAt, stale: solana.value.freshness?.stale ?? false });
      if (rhc.status === "fulfilled" && rhc.value.fetchedAt)
        next.set("robinhood", { chain: "robinhood", fetchedAt: rhc.value.fetchedAt, stale: rhc.value.snapshot?.stale ?? false });
      return (["solana", "robinhood"] as const).flatMap((chain) => next.get(chain) ?? []);
    });
    setError(null);
  }, []);

  useEffect(() => {
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      void load(aborter.signal);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      aborter.abort();
    };
  }, [load]);

  const pools = useMemo(() => (byChain ? [...(byChain.solana ?? []), ...(byChain.robinhood ?? [])] : null), [byChain]);
  // Every pool is listed, so every pool's 7-day APR is loaded (the /app/rwa-pairs APR state). Every Solana pool here
  // comes from `/api/rwa-pairs`, so its Meteora pools read their saved APR snapshot.
  const all = useMemo(() => pools ?? [], [pools]);
  const rwaListKeys = useMemo(() => new Set(all.filter((pool) => pool.chain === "solana").map((pool) => pool.key)), [all]);
  const apr = usePoolsApr7d(all, 0, rwaListKeys);
  const serverApr = initial?.apr7d;
  // Until a pool's estimate loads on the client, the server snapshot's value ranks it, so the server HTML and the first
  // client render list the same pools in the same order. The figures themselves are only printed once loaded here
  // ("…" before): the cached HTML never states an APR.
  const apr7d = useCallback((pool: UnifiedPool) => {
    const state = apr[pool.key];
    if (state?.status === "ready") return state.aprPct;
    // Missing, or a new pool (too few days of data): no APR, so it is left out of the ranking.
    if (state && state.status !== "loading") return null;
    const saved = serverApr?.[pool.key];
    return typeof saved === "number" && Number.isFinite(saved) ? saved : null;
  }, [apr, serverApr]);
  const group = useMemo(() => rankGroupLookup(apr), [apr]);
  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    void load();
  }, [load]);
  return { pools, apr, apr7d, group, icons, updatedText: updatedLabel(updated), loading, error, retry };
}

/**
 * The best range's 7-day APR as plain text for the Top Pools card ("…" until it loads on the client): the same number
 * as the pool's card on `/app/rwa-pairs` (`summarizeApr7d`), so the card and Top Pools always agree.
 */
function aprText(state: Apr7dState | undefined): string {
  if (state?.status === "ready") return pct(state.aprPct);
  if (state?.status === "new") return NEW_POOL_LABEL;
  return state?.status === "missing" ? "—" : "…";
}

/** The best range's name once the estimate is ready ("Tight", "Micro", "Min (±10 ticks)"…). */
function rangeOf(state: Apr7dState | undefined): string | null {
  return state?.status === "ready" ? state.rangeLabel : null;
}

/** Tooltip for a Top Pools APR: which range it is, then how it is estimated. */
function aprTitle(state: Apr7dState | undefined): string {
  const range = rangeOf(state);
  return range ? `Best range: ${range}. ${HIGHEST_RANGE_APR_7D_HELP}` : HIGHEST_RANGE_APR_7D_HELP;
}

/**
 * One Top Pools row, laid out like a Top Stocks row (rank, icons, name over a mono line, figure over a small line). The
 * whole row opens the pool on `/app/rwa-pairs`; a pool that cannot be opened there is a plain row with the reason as
 * its tooltip.
 */
function TopPoolRow({ pool, rank, data }: { pool: UnifiedPool; rank: number; data: HomepagePoolsData }) {
  const action = openAction(pool);
  const where = `${PROTOCOL_LABELS[pool.protocol]} · ${CHAIN_LABELS[pool.chain]}`;
  const body = <>
    <span className="w-4 shrink-0 font-data text-xs text-smoke">{rank}</span>
    <PairTokenIcons pair={iconPair(pool)} icons={data.icons} chain={pool.chain} ringClassName="ring-char" layout="stacked" />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-semibold text-cream">{pool.pairLabel}</span>
      <span className="block truncate font-data text-[11px] uppercase tracking-[0.08em] text-smoke" title={where}>{where}</span>
    </span>
    <span className="shrink-0 text-right">
      <span data-testid="top-pool-apr" className="block font-data text-sm tabular-nums text-cream" title={aprTitle(data.apr[pool.key])}>{aprText(data.apr[pool.key])}</span>
      {rangeOf(data.apr[pool.key]) ? <span className="sr-only">, {rangeOf(data.apr[pool.key])} range</span> : null}
      <span className="block font-data text-xs tabular-nums text-smoke">TVL {money(pool.tvlUsd)}</span>
    </span>
  </>;
  if (action.kind === "link") {
    return <li data-pool={pool.key}>
      <Link href={action.href} className={cn(marketRow, "outline-none transition-colors hover:bg-white/[0.05] focus-visible:shadow-[inset_0_0_0_2px_var(--color-lilac)]")}>
        {body}<span className="sr-only">: open position</span>
      </Link>
    </li>;
  }
  const reason = action.kind === "open" ? "" : action.reason;
  return <li data-pool={pool.key} data-testid="top-pool-unavailable" title={reason} className={cn(marketRow, "cursor-default")}>
    {body}<span className="sr-only">: {reason}</span>
  </li>;
}

/**
 * Top Pools: the old homepage top 5, i.e. `/app/rwa-pairs`' default view with the homepage TVL floor (TVL filter →
 * duplicate rule → Est. APR · 7d, high to low), in the same frame as Top Gainers / Top Stocks.
 */
export function TopPoolsCard({ data, className }: { data: HomepagePoolsData; className?: string }) {
  const rows = useMemo(() => (data.pools ? homepageRows(data.pools, data.apr7d, undefined, data.group) : []), [data.pools, data.apr7d, data.group]);
  // When the client estimates re-rank the top 5, the rows slide to their new places instead of swapping.
  const list = useRef<HTMLOListElement | null>(null);
  useFlipRows(list, "li[data-pool]");
  return <MarketCard testId="top-pools-card" title="Top Pools" subtitle={`Pools over $${HOMEPAGE_MIN_TVL_USD / 1_000}k TVL, by best range APR.`}
    pill="Best range · 7d" className={className}>
    {!data.pools ? (data.error ? <p role="status" className="mt-3 px-1 text-sm text-smoke">Pools could not be loaded right now.</p> : <MarketRowsSkeleton label="Loading pool data…" />)
      : rows.length ? <ol ref={list} className={marketRowsPanel}>
        {rows.map((pool, index) => <TopPoolRow key={pool.key} pool={pool} rank={index + 1} data={data} />)}
      </ol> : <p className="mt-3 px-1 text-sm text-smoke">No pools to show right now.</p>}
  </MarketCard>;
}

/** Search box for the pools list (the hero's search edits the same query). */
export function PoolSearchInput({ query, onQueryChange, placeholder, className, inputClassName, id }: {
  query: string; onQueryChange: (query: string) => void; placeholder: string; className?: string; inputClassName?: string; id?: string;
}) {
  return <div className={cn("flex items-center gap-3 border border-white/15 bg-white/[0.04] text-cream transition-colors focus-within:border-white/45", className)}>
    <Search className="h-4 w-4 shrink-0 text-smoke" aria-hidden="true" />
    <input id={id} type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={placeholder}
      aria-label="Search pools" autoComplete="off" spellCheck={false}
      className={cn("min-w-0 flex-1 bg-transparent outline-none placeholder:text-smoke [&::-webkit-search-cancel-button]:hidden", inputClassName)} />
    {query && <button type="button" onClick={() => onQueryChange("")} aria-label="Clear search" className="rounded-full p-1 text-smoke hover:text-cream">
      <X className="h-4 w-4" aria-hidden="true" />
    </button>}
  </div>;
}

/** The full list's rows: `/app/rwa-pairs`' default view (no TVL floor, duplicates hidden) with the search and sort. */
export function homepageListRows(data: Pick<HomepagePoolsData, "pools" | "apr7d" | "group">, query: string, sort: { key: SortKey; dir: SortDir }) {
  if (!data.pools) return { pools: [], hiddenDuplicates: 0 };
  return selectPools(data.pools, { ...RWA_PAIRS_DEFAULT_SELECT, filters: { ...RWA_PAIRS_DEFAULT_SELECT.filters, query }, sort, apr7d: data.apr7d, group: data.group });
}

/**
 * Every pool, rendered with the same `PoolTable` as `/app/rwa-pairs`' List view (sortable, by Est. APR · 7d high to low
 * by default) and filtered by the homepage search. A shared link's pool (`?pool=`) is marked.
 */
export function HomepagePoolsList({ data, query, onQueryChange, highlightPool }: {
  data: HomepagePoolsData; query: string; onQueryChange: (query: string) => void; highlightPool?: string;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>(DEFAULT_SORT);
  const { pools: rows, hiddenDuplicates } = useMemo(() => homepageListRows(data, query, sort), [data, query, sort]);
  const highlightKey = highlightPool ? rows.find((pool) => pool.poolAddress.toLowerCase() === highlightPool.trim().toLowerCase())?.key : undefined;
  const onSort = (key: SortKey) => setSort((current) => (current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_CLICK_DIR[key] }));
  const trimmed = query.trim();
  // Searching and sorting move rows (and the table's height) instead of cutting to the new list.
  const table = useRef<HTMLDivElement | null>(null);
  useFlipRows(table, "tbody tr[data-pool]");

  return (
    <section id="pools" className="scroll-mt-6 pt-14 sm:pt-20" aria-labelledby="homepage-pools-heading">
      <div className="flex flex-col gap-4 px-1 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 id="homepage-pools-heading" className="text-[clamp(1.6rem,2.8vw,2.25rem)] font-medium leading-[1.08] tracking-[-0.035em]">
            All pools
          </h2>
          <p className="mt-2 text-sm text-smoke">
            Same-stock pools on Solana and Robinhood Chain.
            {data.updatedText && <span data-testid="homepage-pools-updated" className="ml-2 font-data text-[11px] uppercase tracking-[0.12em]">{data.updatedText}</span>}
          </p>
        </div>
        <PoolSearchInput id="pools-search" query={query} onQueryChange={onQueryChange} placeholder="Filter by stock or token" className="h-11 w-full rounded-full px-4 md:w-80" inputClassName="text-base sm:text-sm" />
      </div>

      {data.loading && !data.pools && (
        <p role="status" className="inline-flex items-center gap-2 px-1 py-8 text-sm text-smoke">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading pool data…
        </p>
      )}

      {data.error && (
        <div role="alert" className="mt-3 rounded-surface border border-white/20 bg-white/[0.04] p-4 text-sm text-cream/80">
          <p>{data.error}</p>
          <button
            type="button"
            className="mt-3 inline-flex h-10 items-center rounded-full border border-white/30 px-4 text-sm font-semibold text-cream hover:border-cream"
            onClick={data.retry}
          >
            Try again
          </button>
        </div>
      )}

      {/* One box for the table and its empty state, so a search that empties the list (or refills it) eases its height. */}
      {data.pools && (
        <div ref={table} data-testid="homepage-pools-table">
          {rows.length > 0 ? <PoolTable pools={rows} apr={data.apr} actionFor={openAction} sort={sort} onSort={onSort} icons={data.icons} highlightKey={highlightKey}
            testId="homepage-pools-list" />
            : !data.loading && !data.error && <p data-testid="homepage-pools-empty" className="px-1 py-8 text-sm text-smoke">
              {trimmed ? <>No pools match “{trimmed}”. <button type="button" onClick={() => onQueryChange("")} className="text-cream underline underline-offset-2">Clear search</button></> : "No pools to show right now."}
            </p>}
        </div>
      )}

      {(data.pools || data.error) && (
        <div className="mt-4 flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-2xl text-xs leading-5 text-smoke">
            {data.pools && <span className="block" data-testid="homepage-pools-count">
              {rows.length} {rows.length === 1 ? "pool" : "pools"}{trimmed ? ` match “${trimmed}”` : ""}
              {hiddenDuplicates > 0 && ` · ${hiddenDuplicates} duplicate ${hiddenDuplicates === 1 ? "pool" : "pools"} of the same pair hidden`}.
            </span>}
            Ranked by the 7-day estimate, high to low (on Solana, for a range picked from the past 7 days of fee data). {HIGHEST_RANGE_APR_7D_HELP}{" "}
            Not LP return; ignores IL and rewards. A position out of its range collects no fees. Data: Raydium API (Solana);
            GeckoTerminal / DexScreener (Robinhood Chain), updated every few hours{data.updatedText ? ` · ${data.updatedText}` : ""}.
          </p>
          <div className="flex shrink-0 items-center gap-4">
            <Link href={DOCS_ROUTES.feeApr} className="text-sm text-cream/70 underline underline-offset-2 hover:text-cream">
              {HOMEPAGE_APR_DOCS_LINK_LABEL}
            </Link>
            <Link href={DOCS_ROUTES.risks} className="text-sm text-cream/70 underline underline-offset-2 hover:text-cream">
              Risks
            </Link>
            <Link
              href={APP_ROUTES.rwaPairs}
              data-testid="homepage-view-all"
              className="text-sm font-semibold text-cream underline-offset-2 hover:underline"
            >
              Open in app →
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
