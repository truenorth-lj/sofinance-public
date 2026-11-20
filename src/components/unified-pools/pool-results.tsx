"use client";

import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import { HIGHEST_RANGE_APR_7D_HELP, HOMEPAGE_APR_DOCS_LINK_LABEL } from "@/lib/apr-labels/copy";
import { APP_ROUTES, DOCS_ROUTES, buildCalculatePath } from "@/lib/public-urls";
import {
  TOP_POOLS_ANCHOR_ID,
  TOP_POOLS_SUBTITLE,
  TOP_POOLS_TITLE,
  seeAllPoolsLabel,
} from "@/lib/homepage-pools";
import type { TokenIconMap } from "@/lib/token-icons/map";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import type {
  Apr7dLookup,
  SortDir,
  SortKey,
  UnifiedPool,
} from "@/lib/unified-pools/model";
import { PoolTable, type OpenAction } from "./pool-list";
import { PoolCard } from "./pool-card";

export type PoolResultsMode = "top" | "full";

type Shared = {
  pools: readonly UnifiedPool[];
  apr: Readonly<Record<string, Apr7dState | undefined>>;
  actionFor: (pool: UnifiedPool) => OpenAction;
  icons?: TokenIconMap;
  /** Server-built `pool.key → /pools/<slug>` map; missing keys stay unlinked. */
  detailHrefs?: Readonly<Record<string, string>>;
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

function FullPoolResults({ view, pools, apr, actionFor, sort, onSort, icons, onCalculate, detailHrefs }: FullPoolResultsProps) {
  return view === "cards"
    ? <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="pools-cards">
        {pools.map((pool) => <PoolCard key={pool.key} pool={pool} apr={apr[pool.key]} action={actionFor(pool)} icons={icons}
          onCalculate={() => onCalculate(pool)} detailHref={detailHrefs?.[pool.key]} />)}
      </ul>
    : <PoolTable pools={pools} apr={apr} actionFor={actionFor} sort={sort} onSort={onSort} icons={icons} detailHrefs={detailHrefs} />;
}

/**
 * APR state the homepage cards print: the live estimate once it is ready (or a known miss / new pool),
 * otherwise a ready state from the server snapshot so crawlers already see the number in the HTML.
 * Snapshot values have no range label until the client estimate loads.
 */
export function cardAprState(state: Apr7dState | undefined, saved: number | null): Apr7dState | undefined {
  if (state?.status === "ready" || state?.status === "new" || state?.status === "missing") return state;
  if (typeof saved === "number" && Number.isFinite(saved)) {
    return { status: "ready", aprPct: saved, rangeLabel: "", lowConfidence: false, avgDailyVolumeUsd: null };
  }
  return state;
}

function TopPoolResults({
  pools, apr, apr7d, actionFor, icons, totalCount, updatedText, loading, error, onRetry, detailHrefs,
}: TopPoolResultsProps) {
  return (
    <section id={TOP_POOLS_ANCHOR_ID} className="scroll-mt-6 pt-14 sm:pt-20" aria-labelledby="top-pools-heading" data-testid="top-pools">
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
        // Mobile: one-column stack (the same card as /app/rwa-pairs, shown in full — no sideways scroll of a tall
        // card). Desktop: 3+2 grid. Five in one row does not fit in the homepage's 1280px shell without squeezing
        // these cards narrower than the app's own 3-column grid.
        <ul className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="top-pools-cards">
          {pools.map((pool) => (
            <PoolCard
              key={pool.key}
              pool={pool}
              apr={cardAprState(apr[pool.key], apr7d(pool))}
              action={actionFor(pool)}
              icons={icons}
              calculateHref={buildCalculatePath(pool.poolAddress)}
              detailHref={detailHrefs?.[pool.key]}
            />
          ))}
        </ul>
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
