"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { HIGHEST_RANGE_APR_7D_HELP, HOMEPAGE_APR_DOCS_LINK_LABEL } from "@/lib/apr-labels/copy";
import {
  buildHomepagePools,
  homepageRows,
  updatedLabel,
  type HomepagePool,
  type HomepagePoolsSnapshot,
  type HomepageSolanaRow,
  type HomepageSourceTime,
} from "@/lib/homepage-pools";
import { isRhcUniv4DiscoveryEnabled } from "@/lib/protocol-flags";
import { fetchRwaPairsList } from "@/lib/rwa-pairs-list";
import { APP_ROUTES, DOCS_ROUTES, buildOpenPositionPath } from "@/lib/public-urls";
import { DEFAULT_SORT, type PoolChain, type UnifiedPool } from "@/lib/unified-pools/model";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";
import { PoolTable, type OpenAction } from "./unified-pools/pool-list";
import { usePoolsApr7d } from "./unified-pools/use-pools-apr7d";
import type { TokenIconMap } from "@/lib/token-icons/map";

type PairsResponse = {
  pairs?: HomepageSolanaRow[];
  tokenIcons?: TokenIconMap;
  fetchedAt?: string;
  freshness?: { snapshotAt: string; stale: boolean };
};
type RhcResponse = { pools?: RhcPoolSummary[]; fetchedAt?: string; snapshot?: { stale?: boolean } };

const RHC_POOLS_URL = "/api/protocol-pools?protocol=uniswap-v4-rhc";

/** Solana pools open the Create position modal (`?pool=…&open=1`); Robinhood Chain pools open their dialog (`?openPool=…`). */
export function openPoolHref(pool: Pick<HomepagePool, "chain" | "poolAddress">) {
  return pool.chain === "robinhood"
    ? `${APP_ROUTES.rwaPairs}?openPool=${encodeURIComponent(pool.poolAddress)}`
    : buildOpenPositionPath(pool.poolAddress);
}

const openAction = (pool: UnifiedPool): OpenAction => ({ kind: "link", href: openPoolHref(pool) });

/** Reads the `?pool=` tweet deep link, then renders the table (client-only: inside the landing page's Suspense). */
export function HomepagePoolsTable({ initial }: { initial?: HomepagePoolsSnapshot | null }) {
  const highlightPool = useSearchParams().get("pool") ?? undefined;
  return <HomepagePoolsView initial={initial} highlightPool={highlightPool} />;
}

type ChainPools = Partial<Record<PoolChain, HomepagePool[]>>;
const NO_POOLS: HomepagePool[] = [];

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

/**
 * The top pools of `/app/rwa-pairs` (both chains in one list, by Est. APR · 7d, at most 5), rendered with the same
 * `PoolTable` as its List view. `initial` is the server snapshot (ISR) so the
 * prerendered HTML already lists the same pools with chain, protocol and TVL (ranked by the saved 7-day APRs) plus the "Updated … UTC" time of the saved lists;
 * after mount it refreshes from the CDN-cached `/api/rwa-pairs` and `/api/protocol-pools?protocol=uniswap-v4-rhc`. A
 * chain whose refresh fails keeps its server rows. Without a snapshot it shows "Loading pool data…" until a fetch returns.
 */
export function HomepagePoolsView({
  initial,
  highlightPool,
}: {
  initial?: HomepagePoolsSnapshot | null;
  highlightPool?: string;
}) {
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
      // Keep showing the server snapshot when the refresh fails; only an empty table shows the error.
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
  // Same 7-day APR state as /app/rwa-pairs; until a pool's estimate loads, the server snapshot's value stands in, so
  // the server HTML and the first client render pick the same pool per pair.
  const apr = usePoolsApr7d(pools ?? NO_POOLS);
  // The prerendered HTML (and the first client render) prints no APR figure; the 24h column fills in after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const serverApr = initial?.apr7d;
  // Until a pool's estimate loads on the client, the server snapshot's value ranks it, so the server HTML and the first
  // client render list the same pools in the same order. The figures themselves are only printed once loaded here
  // ("…" before): the cached HTML never states an APR.
  const apr7d = useCallback((pool: UnifiedPool) => {
    const state = apr[pool.key];
    if (state?.status === "ready") return state.aprPct;
    if (state?.status === "missing") return null;
    const saved = serverApr?.[pool.key];
    return typeof saved === "number" && Number.isFinite(saved) ? saved : null;
  }, [apr, serverApr]);
  const rows = useMemo(() => (pools ? homepageRows(pools, apr7d, highlightPool) : []), [pools, apr7d, highlightPool]);
  const updatedText = updatedLabel(updated);
  const highlightKey = highlightPool ? rows.find((pool) => pool.poolAddress.toLowerCase() === highlightPool.trim().toLowerCase())?.key : undefined;

  return (
    <section id="pools" className="scroll-mt-6" aria-labelledby="homepage-pools-heading">
      <div className="mb-3 flex flex-col gap-4 px-2 pt-10 sm:pt-12">
        <span className="inline-flex h-6 w-fit items-center whitespace-nowrap rounded-full border border-white/30 px-2.5 font-data text-[10px] uppercase tracking-[0.14em] text-cream/80">
          Live pools
        </span>
        <h2
          id="homepage-pools-heading"
          className="max-w-3xl text-[clamp(1.7rem,3.4vw,2.75rem)] font-medium leading-[1.08] tracking-[-0.035em]"
        >
          Top pools on Solana and Robinhood Chain, by est. 7-day APR
        </h2>
        {updatedText && (
          <p data-testid="homepage-pools-updated" className="font-data text-[11px] uppercase tracking-[0.12em] text-smoke">
            {updatedText}
          </p>
        )}
      </div>

      {loading && !pools && (
        <p role="status" className="inline-flex items-center gap-2 px-2 py-8 text-sm text-smoke">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading pool data…
        </p>
      )}

      {error && (
        <div role="alert" className="rounded-2xl border border-white/20 bg-white/[0.04] p-4 text-sm text-cream/80">
          <p>{error}</p>
          <button
            type="button"
            className="mt-3 inline-flex h-10 items-center rounded-full border border-white/30 px-4 text-sm font-semibold text-cream hover:border-cream"
            onClick={() => {
              setLoading(true);
              setError(null);
              void load();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {pools && rows.length === 0 && !loading && !error && (
        <p className="px-2 py-8 text-sm text-smoke">No pools to show right now.</p>
      )}

      {rows.length > 0 && (
        <div data-testid="homepage-pools-table">
          <PoolTable pools={rows} apr={apr} actionFor={openAction} sort={DEFAULT_SORT} icons={icons} highlightKey={highlightKey}
            testId="homepage-pools-list" apr24hPending={!mounted} />
        </div>
      )}

      {(pools || error) && (
        <div className="mt-4 flex flex-col gap-3 px-2 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-2xl text-xs leading-5 text-smoke">
            Ranked by Est. APR · 7d, high to low (on Solana, from a 7-day backtest of candidate ranges). {HIGHEST_RANGE_APR_7D_HELP}{" "}
            Not LP return; ignores IL and rewards. Data: Raydium API (Solana); GeckoTerminal / DexScreener (Robinhood
            Chain), saved once a day{updatedText ? ` · ${updatedText}` : ""}.
          </p>
          <div className="flex shrink-0 items-center gap-4">
            <Link href={DOCS_ROUTES.feeApr} className="text-sm text-cream/70 underline underline-offset-2 hover:text-cream">
              {HOMEPAGE_APR_DOCS_LINK_LABEL}
            </Link>
            <Link
              href={APP_ROUTES.rwaPairs}
              data-testid="homepage-view-all"
              className="text-sm font-semibold text-cream underline-offset-2 hover:underline"
            >
              View all pools →
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
