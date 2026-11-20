"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildHomepagePools,
  homepageFullListCount,
  homepageRows,
  updatedLabel,
  type HomepagePool,
  type HomepagePoolsSnapshot,
  type HomepageSolanaRow,
  type HomepageSourceTime,
} from "@/lib/homepage-pools";
import { isRhcUniv4DiscoveryEnabled } from "@/lib/protocol-flags";
import { fetchRwaPairsList } from "@/lib/rwa-pairs-list";
import {
  type PoolChain, type UnifiedPool,
} from "@/lib/unified-pools/model";
import { openAction } from "@/lib/unified-pools/open-action";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";
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


/**
 * The homepage's single top-5 block: `PoolResults` in `mode="top"`.
 */
export function HomepageTopPools({ data, detailHrefs }: {
  data: HomepagePoolsData;
  detailHrefs?: Readonly<Record<string, string>>;
}) {
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
    detailHrefs={detailHrefs}
  />;
}
