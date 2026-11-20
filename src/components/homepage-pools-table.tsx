"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import {
  buildHomepagePools,
  homepageFullListCount,
  homepageRows,
  RWA_PAIRS_DEFAULT_SELECT,
  updatedLabel,
  type HomepagePool,
  type HomepagePoolsSnapshot,
  type HomepageSolanaRow,
  type HomepageSourceTime,
} from "@/lib/homepage-pools";
import { isRhcUniv4DiscoveryEnabled } from "@/lib/protocol-flags";
import { dexDescriptors, uiFor, openCapabilityFor } from "@/lib/dex/client";
import { fetchRwaPairsList } from "@/lib/rwa-pairs-list";
import { APP_ROUTES } from "@/lib/public-urls";
import {
  selectPools, unsupportedTokenReason,
  type PoolChain, type SortDir, type SortKey, type UnifiedPool,
} from "@/lib/unified-pools/model";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";
import { cn } from "@/lib/cn";
import { type OpenAction } from "./unified-pools/pool-list";
import { PoolResults } from "./unified-pools/pool-results";
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
 * Open as on `/app/rwa-pairs`: tokens not supported yet say so; a registry or hidden registry DEX
 * (`openUi: "registry"` or `"none"`, today Meteora and Orca) is disabled when its `open` capability is
 * unsupported. Native-modal availability follows the native capability record; other pools keep
 * their deep links. The app page resolves the same UI contract. No DEX-name checks here.
 */
const openAction = (pool: UnifiedPool): OpenAction => {
  const unsupported = unsupportedTokenReason(pool);
  if (unsupported) return { kind: "unsupported", reason: unsupported };
  // Resolve the capability for the chosen UI contract. A native modal reads its
  // native declaration; generic StepResult readiness still governs registry shells.
  const openUi = uiFor(pool.protocol).openUi;
  if (openUi === "registry" || openUi === "none" || openUi === "native-modal") {
    const open = openCapabilityFor(dexDescriptors.descriptorFor(pool.protocol));
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
 * The homepage's pools, for the top-5 block. `initial` is the server snapshot (ISR) so the
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
  // Until a pool's estimate loads on the client, the server snapshot's value ranks it (and is printed in the top-5
  // block), so the server HTML and the first client render list the same pools, in the same order, with the same numbers.
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
 * The homepage's single top-5 block: `PoolResults` in `mode="top"`.
 */
export function HomepageTopPools({ data }: { data: HomepagePoolsData }) {
  const rows = useMemo(() => (data.pools ? homepageRows(data.pools, data.apr7d, data.group) : []), [data.pools, data.apr7d, data.group]);
  const totalCount = useMemo(() => (data.pools ? homepageFullListCount(data.pools, data.apr7d, data.group) : 0), [data.pools, data.apr7d, data.group]);
  return <PoolResults
    mode="top"
    pools={rows}
    apr={data.apr}
    apr7d={data.apr7d}
    actionFor={openAction}
    icons={data.icons}
    totalCount={data.pools ? totalCount : null}
    updatedText={data.updatedText}
    loading={Boolean(data.loading && !data.pools)}
    error={data.pools ? null : data.error}
    onRetry={data.retry}
  />;
}
