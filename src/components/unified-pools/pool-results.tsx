"use client";

import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import { HIGHEST_RANGE_APR_7D_HELP, HOMEPAGE_APR_DOCS_LINK_LABEL } from "@/lib/apr-labels/copy";
import { formatAprPct } from "@/lib/apr-labels/format-apr";
import { APP_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import {
  TOP_POOLS_SUBTITLE,
  TOP_POOLS_TITLE,
  seeAllPoolsLabel,
} from "@/lib/homepage-pools";
import type { TokenIconMap } from "@/lib/token-icons/map";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import {
  PROTOCOL_LABELS,
  type Apr7dLookup,
  type SortDir,
  type SortKey,
  type UnifiedPool,
} from "@/lib/unified-pools/model";
import { cn } from "@/lib/cn";
import { PairTokenIcons } from "../pair-token-icons";
import { NEW_POOL_LABEL, ChainBadge, PoolTable, iconPair, money, type OpenAction } from "./pool-list";
import { PoolCard } from "./pool-card";

export type PoolResultsMode = "top" | "full";

type Shared = {
  pools: readonly UnifiedPool[];
  apr: Readonly<Record<string, Apr7dState | undefined>>;
  actionFor: (pool: UnifiedPool) => OpenAction;
  icons?: TokenIconMap;
};

export type FullPoolResultsProps = Shared & {
  mode: "full";
  view: "cards" | "list";
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  onCalculate: (pool: UnifiedPool) => void;
};

export type TopPoolResultsProps = Shared & {
  mode: "top";
  /** Saved or live 7-day APR used so the server HTML already prints the numbers. */
  apr7d: Apr7dLookup;
  /** Real count of pools in the /app/rwa-pairs default list ("See all N"). Null until the list has loaded. */
  totalCount: number | null;
  updatedText?: string | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

export type PoolResultsProps = FullPoolResultsProps | TopPoolResultsProps;

/**
 * Pool results extracted from `UnifiedPoolsPanel`. `mode="full"` is the /app/rwa-pairs cards/list view (no visible
 * change). `mode="top"` is the homepage's single top-5 block.
 */
export function PoolResults(props: PoolResultsProps) {
  return props.mode === "full" ? <FullPoolResults {...props} /> : <TopPoolResults {...props} />;
}

function FullPoolResults({ view, pools, apr, actionFor, sort, onSort, icons, onCalculate }: FullPoolResultsProps) {
  return view === "cards"
    ? <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="pools-cards">
        {pools.map((pool) => <PoolCard key={pool.key} pool={pool} apr={apr[pool.key]} action={actionFor(pool)} icons={icons}
          onCalculate={() => onCalculate(pool)} />)}
      </ul>
    : <PoolTable pools={pools} apr={apr} actionFor={actionFor} sort={sort} onSort={onSort} icons={icons} />;
}

/**
 * The figure the top-5 row prints: the live estimate once it is ready, otherwise the server snapshot so crawlers
 * already see the number in the HTML. A known miss or a new pool keeps their labels; only an unknown value is "…".
 */
export function displayedTopApr(state: Apr7dState | undefined, saved: number | null): string {
  if (state?.status === "ready") return formatAprPct(state.aprPct);
  if (state?.status === "new") return NEW_POOL_LABEL;
  if (state?.status === "missing") return "—";
  return typeof saved === "number" && Number.isFinite(saved) ? formatAprPct(saved) : (state?.status === "loading" || !state ? "…" : "—");
}

function rangeOf(state: Apr7dState | undefined): string | null {
  return state?.status === "ready" ? state.rangeLabel : null;
}

function aprTitle(state: Apr7dState | undefined): string {
  const range = rangeOf(state);
  return range ? `Best range: ${range}. ${HIGHEST_RANGE_APR_7D_HELP}` : HIGHEST_RANGE_APR_7D_HELP;
}

function TopPoolResults({
  pools, apr, apr7d, actionFor, icons, totalCount, updatedText, loading, error, onRetry,
}: TopPoolResultsProps) {
  return (
    <section id="pools" className="scroll-mt-6 pt-14 sm:pt-20" aria-labelledby="top-pools-heading" data-testid="top-pools">
      <div className="flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="top-pools-heading" className="text-[clamp(1.6rem,2.8vw,2.25rem)] font-medium leading-[1.08] tracking-[-0.035em]">
            {TOP_POOLS_TITLE}
          </h2>
          <p className="mt-2 text-sm text-smoke">
            {TOP_POOLS_SUBTITLE}
            {updatedText && <span data-testid="homepage-pools-updated" className="ml-2 font-data text-[11px] uppercase tracking-[0.12em]">{updatedText}</span>}
          </p>
        </div>
        {!loading && totalCount !== null && (
          <Link
            href={APP_ROUTES.rwaPairs}
            data-testid="homepage-view-all"
            className="shrink-0 text-sm font-semibold text-cream underline-offset-2 hover:underline"
          >
            {seeAllPoolsLabel(totalCount)}
          </Link>
        )}
      </div>

      {loading && (
        <p role="status" className="inline-flex items-center gap-2 px-1 py-8 text-sm text-smoke">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading pool data…
        </p>
      )}

      {error && (
        <div role="alert" className="mt-3 rounded-surface border border-white/20 bg-white/[0.04] p-4 text-sm text-cream/80">
          <p>{error}</p>
          {onRetry && (
            <button
              type="button"
              className="mt-3 inline-flex h-10 items-center rounded-full border border-white/30 px-4 text-sm font-semibold text-cream hover:border-cream"
              onClick={onRetry}
            >
              Try again
            </button>
          )}
        </div>
      )}

      {!loading && !error && pools.length === 0 && (
        <p data-testid="top-pools-empty" className="px-1 py-8 text-sm text-smoke">No pools to show right now.</p>
      )}

      {pools.length > 0 && (
        <div className="mt-6 overflow-x-auto" data-testid="top-pools-table">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-white/15">
                <th scope="col" className="px-3 py-3 font-data text-[10px] font-normal uppercase tracking-[0.12em] text-smoke">Pool</th>
                <th scope="col" className="px-3 py-3 font-data text-[10px] font-normal uppercase tracking-[0.12em] text-smoke">Chain</th>
                <th scope="col" className="px-3 py-3 text-right font-data text-[10px] font-normal uppercase tracking-[0.12em] text-smoke">TVL</th>
                <th scope="col" className="px-3 py-3 text-right font-data text-[10px] font-normal uppercase tracking-[0.12em] text-smoke">APR</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((pool, index) => (
                <TopPoolRow key={pool.key} pool={pool} rank={index + 1} state={apr[pool.key]} saved={apr7d(pool)} action={actionFor(pool)} icons={icons} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(pools.length > 0 || error) && (
        <div className="mt-4 flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-2xl text-xs leading-5 text-smoke">
            {HIGHEST_RANGE_APR_7D_HELP} Not LP return; ignores IL and rewards. A position out of its range collects no fees.
          </p>
          <div className="flex shrink-0 items-center gap-4">
            <Link href={DOCS_ROUTES.feeApr} className="text-sm text-cream/70 underline underline-offset-2 hover:text-cream">
              {HOMEPAGE_APR_DOCS_LINK_LABEL}
            </Link>
            <Link href={DOCS_ROUTES.risks} className="text-sm text-cream/70 underline underline-offset-2 hover:text-cream">
              Risks
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}

function TopPoolRow({ pool, rank, state, saved, action, icons }: {
  pool: UnifiedPool; rank: number; state: Apr7dState | undefined; saved: number | null; action: OpenAction; icons?: TokenIconMap;
}) {
  const range = rangeOf(state);
  const href = action.kind === "link" ? action.href : null;
  const reason = action.kind === "link" || action.kind === "open" ? "" : action.reason;
  return (
    <tr
      data-pool={pool.key}
      data-chain={pool.chain}
      data-testid={href ? "top-pool-row" : "top-pool-unavailable"}
      title={reason || undefined}
      className={cn("relative border-b border-white/10", href && "transition-colors hover:bg-white/[0.05]")}
    >
      <td className="px-3 py-3">
        <span className="flex items-center gap-3">
          <span className="w-4 shrink-0 font-data text-xs text-smoke">{rank}</span>
          <PairTokenIcons pair={iconPair(pool)} icons={icons} chain={pool.chain} ringClassName="ring-char" layout="stacked" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-cream">{pool.pairLabel}</span>
            <span className="block truncate font-data text-[11px] uppercase tracking-[0.08em] text-smoke">{PROTOCOL_LABELS[pool.protocol]}</span>
          </span>
        </span>
        {href ? (
          <Link href={href} aria-label={`Open position in ${pool.pairLabel}`} className="absolute inset-0 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-lilac)]">
            <span className="sr-only">: open position</span>
          </Link>
        ) : reason ? <span className="sr-only">: {reason}</span> : null}
      </td>
      <td className="px-3 py-3"><ChainBadge chain={pool.chain} tone="dark" /></td>
      <td className="relative px-3 py-3 text-right font-data text-sm tabular-nums text-cream" data-testid="top-pool-tvl">{money(pool.tvlUsd)}</td>
      <td className="relative px-3 py-3 text-right">
        <span data-testid="top-pool-apr" className="font-data text-sm tabular-nums text-cream" title={aprTitle(state)}>{displayedTopApr(state, saved)}</span>
        {range ? <span className="sr-only">, {range} range</span> : null}
      </td>
    </tr>
  );
}
