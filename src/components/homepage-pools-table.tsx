"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { HOMEPAGE_POOL_APR_LABEL, POOL_FEE_APR_24H_HELP } from "@/lib/apr-labels/copy";
import {
  formatAprPct,
  formatUsd,
  freshnessLabel,
  selectHomepagePools,
  type HomepagePool,
} from "@/lib/homepage-pools";
import { fetchRwaPairsList } from "@/lib/rwa-pairs-list";
import { APP_ROUTES, buildOpenPositionPath } from "@/lib/public-urls";

type PairsResponse = {
  pairs?: HomepagePool[];
  estimatedFeeAprLabel?: string;
  freshness?: { snapshotAt: string; stale: boolean };
  error?: string;
};

const chip =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 font-data text-[10px] uppercase tracking-[0.14em]";

function pairLabel(pool: HomepagePool) {
  return `${pool.wrappedSymbol}/${pool.plainSymbol}`;
}

function OpenPositionLink({ poolId, compact }: { poolId: string; compact?: boolean }) {
  return (
    <Link
      href={buildOpenPositionPath(poolId)}
      className={`group inline-flex h-11 items-center justify-between gap-3 rounded-full bg-lemon pl-4 pr-1.5 text-sm font-semibold text-ink outline-none transition-transform hover:-translate-y-px focus-visible:shadow-[0_0_0_3px_var(--color-lilac)] ${compact ? "w-full sm:w-auto" : ""}`}
    >
      Open position
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-lemon transition-transform group-hover:rotate-45">
        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
      </span>
    </Link>
  );
}

function RiskChips({ pool }: { pool: HomepagePool }) {
  if (!pool.freezeRisk && !pool.token2022A && !pool.token2022B) return null;
  return (
    <span className="mt-1.5 flex flex-wrap gap-1.5">
      {(pool.token2022A || pool.token2022B) && (
        <span className={`${chip} border border-white/20 text-cream/70`}>Token-2022</span>
      )}
      {pool.freezeRisk && <span className={`${chip} bg-coral text-ink`}>Freeze</span>}
    </span>
  );
}

export function HomepagePoolsTable() {
  const highlightPool = useSearchParams().get("pool") ?? undefined;
  const [pairs, setPairs] = useState<HomepagePool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [freshness, setFreshness] = useState<{ snapshotAt: string; stale: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const body = await fetchRwaPairsList<PairsResponse>(signal);
      if (signal?.aborted) return;
      setPairs(body.pairs ?? []);
      setFreshness(body.freshness ?? null);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "Failed to load RWA pairs");
      setLoading(false);
    }
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

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = pairs ? selectHomepagePools(pairs, highlightPool) : [];

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
          Same-asset xStock pools, ranked by TVL
        </h2>
      </div>

      <div className="rounded-[28px] border border-white/12 bg-char p-4 sm:p-6">
        {loading && !pairs && (
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

        {pairs && rows.length === 0 && !loading && !error && (
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
                const highlighted = highlightPool === pool.poolAddress;
                return (
                  <li
                    key={pool.poolAddress}
                    data-pool={pool.poolAddress}
                    data-highlighted={highlighted ? "true" : undefined}
                    className={`rounded-2xl border p-4 ${highlighted ? "border-lemon bg-white/[0.04]" : "border-white/10"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-base font-medium tracking-[-0.02em]">{pairLabel(pool)}</p>
                        {pool.feeTierBps !== null && (
                          <p className="mt-0.5 font-data text-[10px] uppercase tracking-[0.12em] text-smoke">
                            {pool.feeTierBps} bps
                          </p>
                        )}
                        <RiskChips pool={pool} />
                      </div>
                      <div className="text-right">
                        <p className="font-data text-[10px] uppercase tracking-[0.12em] text-smoke">TVL</p>
                        <p className="mt-1 text-lg font-semibold tabular-nums">{formatUsd(pool.tvlUsd)}</p>
                      </div>
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-3 border-t border-white/10 pt-3">
                      <div>
                        <p className="font-data text-[10px] uppercase tracking-[0.12em] text-smoke">
                          {HOMEPAGE_POOL_APR_LABEL}
                        </p>
                        <p className="mt-1 text-lg font-semibold tabular-nums" data-testid="homepage-apr">
                          {formatAprPct(pool.estimatedFeeAprPct)}
                        </p>
                      </div>
                      <OpenPositionLink poolId={pool.poolAddress} compact />
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
                    <th className="px-3 py-3 font-medium">{HOMEPAGE_POOL_APR_LABEL}</th>
                    <th className="px-3 py-3 font-medium">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((pool) => {
                    const highlighted = highlightPool === pool.poolAddress;
                    return (
                      <tr
                        key={pool.poolAddress}
                        data-pool={pool.poolAddress}
                        data-highlighted={highlighted ? "true" : undefined}
                        className={`border-b border-white/10 ${highlighted ? "bg-white/[0.04]" : ""}`}
                      >
                        <td className="px-3 py-4">
                          <p className="text-base font-medium tracking-[-0.02em]">{pairLabel(pool)}</p>
                          {pool.feeTierBps !== null && (
                            <p className="mt-0.5 font-data text-[10px] uppercase tracking-[0.12em] text-smoke">
                              {pool.feeTierBps} bps
                            </p>
                          )}
                          <RiskChips pool={pool} />
                        </td>
                        <td className="px-3 py-4 text-base font-semibold tabular-nums">{formatUsd(pool.tvlUsd)}</td>
                        <td className="px-3 py-4 text-base font-semibold tabular-nums" data-testid="homepage-apr">
                          {formatAprPct(pool.estimatedFeeAprPct)}
                        </td>
                        <td className="px-3 py-4 text-right">
                          <OpenPositionLink poolId={pool.poolAddress} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {(pairs || error) && (
          <div className="mt-5 flex flex-col gap-3 border-t border-white/10 px-2 pt-4 sm:flex-row sm:items-end sm:justify-between">
            <p className="max-w-2xl text-xs leading-5 text-smoke">
              {POOL_FEE_APR_24H_HELP} Not LP return; ignores IL, range and rewards. Data: Raydium API
              {freshness ? ` · ${freshnessLabel(freshness.snapshotAt, now)}` : ""}.
            </p>
            <Link
              href={APP_ROUTES.rwaPairs}
              className="shrink-0 text-sm font-semibold text-cream underline-offset-2 hover:underline"
            >
              See all pools →
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
