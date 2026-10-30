"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import {
  HIGHEST_RANGE_APR_7D_HELP,
  HOMEPAGE_APR_DOCS_LINK_LABEL,
  HOMEPAGE_POOL_APR_LABEL,
} from "@/lib/apr-labels/copy";
import { cn } from "@/lib/cn";
import {
  buildHomepagePools,
  exactAprTitle,
  formatAprPct,
  formatUsd,
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
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import { CHAIN_LABELS, PROTOCOL_LABELS, RISK_LABELS, type PoolChain, type UnifiedPool } from "@/lib/unified-pools/model";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";
import { InfoTip } from "./info-tip";
import { PairTokenIcons } from "./pair-token-icons";
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

const chip =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 font-data text-[10px] uppercase tracking-[0.14em]";

/**
 * The pool's headline APR: the estimated fee APR of its highest-APR candidate range (7-day average), from the same
 * `usePoolsApr7d` state as the /app/rwa-pairs card badge and formatted with the same formatter, so both show the same
 * figure ("<0.01%" for a real but tiny APR, "0.00%" only for a true zero). "…" while loading; "—" when there is no
 * estimate (error, degraded data, or the Robinhood Chain estimate is switched off).
 */
function RangeAprValue({ state }: { state: Apr7dState | undefined }) {
  const ready = state?.status === "ready" ? state : null;
  const text = ready ? formatAprPct(ready.aprPct) : state?.status === "missing" ? "—" : "…";
  return (
    <span
      data-testid="homepage-apr"
      data-apr-status={ready ? "ready" : state?.status === "missing" ? "missing" : "loading"}
      title={ready ? exactAprTitle(ready.aprPct) : undefined}
      className={cn(
        "inline-flex h-8 min-w-[3.5rem] items-center justify-center whitespace-nowrap rounded-full px-3 text-base font-semibold tabular-nums",
        ready ? "bg-lemon text-ink" : "bg-white/[0.06] text-cream/70",
      )}
    >
      {text}
    </span>
  );
}

function AprLabel({ docsLink }: { docsLink?: boolean }) {
  return (
    <span>
      {HOMEPAGE_POOL_APR_LABEL}
      <span className="ml-1.5 inline-block align-[-2px]">
        <InfoTip label="About Est. highest range APR">{HIGHEST_RANGE_APR_7D_HELP}</InfoTip>
      </span>
      {docsLink && (
        <Link
          href={DOCS_ROUTES.feeApr}
          className="ml-1.5 whitespace-nowrap font-display text-[11px] font-normal normal-case tracking-normal text-cream/70 underline underline-offset-2 hover:text-cream"
        >
          {HOMEPAGE_APR_DOCS_LINK_LABEL}
        </Link>
      )}
    </span>
  );
}

/** Chain tag, same colours as the /app/rwa-pairs list (Solana lilac, Robinhood Chain mint). */
function ChainTag({ chain }: { chain: PoolChain }) {
  return (
    <span
      data-testid="homepage-chain"
      data-chain={chain}
      className={cn(chip, chain === "robinhood" ? "bg-mint text-ink" : "bg-lilac text-ink")}
    >
      {CHAIN_LABELS[chain]}
    </span>
  );
}

/** "Raydium · 25 bps" / "Uniswap v4 · dynamic fee" (the StablePair hook sets the fee per swap). */
function protocolLine(pool: HomepagePool) {
  const fee = pool.feeTierBps !== null ? `${pool.feeTierBps} bps` : pool.chain === "robinhood" ? "dynamic fee" : null;
  return fee ? `${PROTOCOL_LABELS[pool.protocol]} · ${fee}` : PROTOCOL_LABELS[pool.protocol];
}

function PoolName({ pool, icons }: { pool: HomepagePool; icons: TokenIconMap | undefined }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <PairTokenIcons pair={pool} icons={icons} chain={pool.chain} ringClassName="ring-char" iconClassName="h-9 w-9 text-xs" />
      <div className="min-w-0">
        <p className="text-base font-medium tracking-[-0.02em]">{pool.pairLabel}</p>
        <p className="mt-0.5 font-data text-[10px] uppercase tracking-[0.12em] text-smoke">{protocolLine(pool)}</p>
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          <ChainTag chain={pool.chain} />
          {!pool.sameAsset && <span className={`${chip} border border-white/20 text-cream/70`}>Stablecoins</span>}
          {pool.risks.map((risk) => (
            <span key={risk} className={`${chip} ${risk === "freeze" ? "bg-coral text-ink" : "border border-white/20 text-cream/70"}`}>
              {RISK_LABELS[risk]}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

/** Solana pools open the Create position modal (`?pool=…&open=1`); Robinhood Chain pools open their dialog (`?openPool=…`). */
export function openPoolHref(pool: Pick<HomepagePool, "chain" | "poolAddress">) {
  return pool.chain === "robinhood"
    ? `${APP_ROUTES.rwaPairs}?openPool=${encodeURIComponent(pool.poolAddress)}`
    : buildOpenPositionPath(pool.poolAddress);
}

function OpenPositionLink({ pool, compact }: { pool: HomepagePool; compact?: boolean }) {
  return (
    <Link
      href={openPoolHref(pool)}
      className={`group inline-flex h-11 items-center justify-between gap-3 rounded-full bg-lemon pl-4 pr-1.5 text-sm font-semibold text-ink outline-none transition-transform hover:-translate-y-px focus-visible:shadow-[0_0_0_3px_var(--color-lilac)] ${compact ? "w-full sm:w-auto" : ""}`}
    >
      Open position
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-lemon transition-transform group-hover:rotate-45">
        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
      </span>
    </Link>
  );
}

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
 * The pools table, both chains in one list (chain tag on every row). `initial` is the server snapshot (ISR) so the
 * prerendered HTML already lists pool names, chain, protocol and TVL plus the "Updated … UTC" time of the saved lists;
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
  const serverApr = initial?.apr7d;
  const apr7d = useCallback((pool: UnifiedPool) => {
    const state = apr[pool.key];
    if (state?.status === "ready") return state.aprPct;
    if (state?.status === "missing") return null;
    const saved = serverApr?.[pool.key];
    return typeof saved === "number" && Number.isFinite(saved) ? saved : null;
  }, [apr, serverApr]);
  const rows = useMemo(() => (pools ? homepageRows(pools, apr7d, highlightPool) : []), [pools, apr7d, highlightPool]);
  const updatedText = updatedLabel(updated);
  const isHighlighted = (pool: HomepagePool) =>
    !!highlightPool && pool.poolAddress.toLowerCase() === highlightPool.trim().toLowerCase();

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
          Same-stock pools on Solana and Robinhood Chain, ranked by TVL
        </h2>
        {updatedText && (
          <p data-testid="homepage-pools-updated" className="font-data text-[11px] uppercase tracking-[0.12em] text-smoke">
            {updatedText}
          </p>
        )}
      </div>

      <div className="rounded-[28px] border border-white/12 bg-char p-4 sm:p-6">
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
          <p className="px-2 py-8 text-sm text-smoke">
            No same-asset pools to show right now.{" "}
            <Link href={APP_ROUTES.rwaPairs} className="text-cream underline underline-offset-2">
              See all pools
            </Link>
          </p>
        )}

        {rows.length > 0 && (
          <>
            <ul className="flex flex-col gap-3 sm:hidden" data-testid="homepage-pools-cards">
              {rows.map((pool) => {
                const highlighted = isHighlighted(pool);
                return (
                  <li
                    key={pool.key}
                    data-pool={pool.poolAddress}
                    data-chain={pool.chain}
                    data-highlighted={highlighted ? "true" : undefined}
                    className={`rounded-2xl border p-4 ${highlighted ? "border-lemon bg-white/[0.04]" : "border-white/10"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <PoolName pool={pool} icons={icons} />
                      <div className="shrink-0 text-right">
                        <p className="font-data text-[10px] uppercase tracking-[0.12em] text-smoke">TVL</p>
                        <p className="mt-1 text-lg font-semibold tabular-nums">{formatUsd(pool.tvlUsd)}</p>
                      </div>
                    </div>
                    <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/10 pt-3">
                      <p className="min-w-0 font-data text-[10px] uppercase leading-4 tracking-[0.12em] text-smoke">
                        <AprLabel />
                      </p>
                      <RangeAprValue state={apr[pool.key]} />
                    </div>
                    <div className="mt-3">
                      <OpenPositionLink pool={pool} compact />
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="hidden overflow-x-auto sm:block" data-testid="homepage-pools-table">
              <table className="w-full min-w-[36rem] border-collapse text-left">
                <thead>
                  <tr className="border-b border-white/10 font-data text-[10px] uppercase tracking-[0.14em] text-smoke">
                    <th className="px-3 py-3 font-medium">Pool</th>
                    <th className="px-3 py-3 font-medium">TVL</th>
                    <th className="px-3 py-3 font-medium">
                      <AprLabel docsLink />
                    </th>
                    <th className="px-3 py-3 font-medium">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((pool) => {
                    const highlighted = isHighlighted(pool);
                    return (
                      <tr
                        key={pool.key}
                        data-pool={pool.poolAddress}
                        data-chain={pool.chain}
                        data-highlighted={highlighted ? "true" : undefined}
                        className={`border-b border-white/10 ${highlighted ? "bg-white/[0.04]" : ""}`}
                      >
                        <td className="px-3 py-4">
                          <PoolName pool={pool} icons={icons} />
                        </td>
                        <td className="px-3 py-4 text-base font-semibold tabular-nums">{formatUsd(pool.tvlUsd)}</td>
                        <td className="px-3 py-4">
                          <RangeAprValue state={apr[pool.key]} />
                        </td>
                        <td className="px-3 py-4 text-right">
                          <OpenPositionLink pool={pool} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {(pools || error) && (
          <div className="mt-5 flex flex-col gap-3 border-t border-white/10 px-2 pt-4 sm:flex-row sm:items-end sm:justify-between">
            <p className="max-w-2xl text-xs leading-5 text-smoke">
              {HIGHEST_RANGE_APR_7D_HELP} Not LP return; ignores IL and rewards.
              {rows.some((pool) => !pool.sameAsset) ? " Stablecoin pools (USDC/USDT) are listed last: they are not same-stock pairs." : ""}{" "}
              Data: Raydium API (Solana); GeckoTerminal / DexScreener (Robinhood
              Chain), saved once a day{updatedText ? ` · ${updatedText}` : ""}.
            </p>
            <div className="flex shrink-0 items-center gap-4">
              <Link
                href={DOCS_ROUTES.feeApr}
                className="text-sm text-cream/70 underline underline-offset-2 hover:text-cream"
              >
                {HOMEPAGE_APR_DOCS_LINK_LABEL}
              </Link>
              <Link
                href={APP_ROUTES.rwaPairs}
                className="text-sm font-semibold text-cream underline-offset-2 hover:underline"
              >
                See all pools →
              </Link>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
