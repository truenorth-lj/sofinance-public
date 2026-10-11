"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { buildPlanPath } from "@/lib/public-urls";
import { cn } from "@/lib/cn";
import { OPEN_RANGE_UI_PRESETS } from "@/lib/open-range-presets";
import {
  APR_ESTIMATE_CAVEAT, HIGHEST_RANGE_APR_LABEL, HIGHEST_RANGE_COLUMN_LABEL, HIGHEST_RANGE_HELP,
} from "@/lib/range-apr/copy";
import { formatAprPct } from "@/lib/range-apr/format";
import { highestRangeSummary } from "@/lib/range-apr/preset-list";
import { pairIssuerLabel } from "@/lib/rwa-pair-names";
import type { TokenMetadata } from "@/lib/token-metadata";
import { InfoTip } from "./info-tip";
import { OpenPositionModal } from "./open-position-modal";
import { usePoolRangeApr } from "./range-apr/use-pool-range-apr";
import { TokenIcon } from "./token-icon";
import type { OpenPositionPair } from "./use-open-position-controller";
import { useTokenMetadata } from "./use-token-metadata";

type RwaPair = {
  poolAddress: string;
  mintA: string;
  mintB: string;
  symbolA: string;
  symbolB: string;
  nameA: string;
  nameB: string;
  baseSymbol: string;
  wrappedSymbol: string;
  plainSymbol: string;
  feeTierBps: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  raydiumFeeApr24h: number | null;
  estimatedFeeAprPct: number | null;
  token2022A: boolean;
  token2022B: boolean;
  freezeRisk: boolean;
  relatedness: string;
  preferredTags?: boolean;
  qualificationA?: string;
  qualificationB?: string;
};

type RwaPairsResponse = {
  pairs: RwaPair[];
  scannedPools: number;
  pagesFetched: number;
  fetchedAt: string;
  pairingRuleSummary: string;
  estimatedFeeAprLabel: string;
  error?: string;
};

const money = (value: number | null, digits = 2) => {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(digits)}`;
};

const pct = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
};

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

const toOpenPair = (pair: RwaPair): OpenPositionPair => ({
  poolAddress: pair.poolAddress,
  mintA: pair.mintA,
  mintB: pair.mintB,
  symbolA: pair.symbolA,
  symbolB: pair.symbolB,
  wrappedSymbol: pair.wrappedSymbol,
  plainSymbol: pair.plainSymbol,
  feeTierBps: pair.feeTierBps,
  token2022A: pair.token2022A,
  token2022B: pair.token2022B,
  freezeRisk: pair.freezeRisk,
});

/** Fallback icon when Jupiter lists none: Raydium serves every listed mint's icon at this path. */
const raydiumIcon = (mint: string) => `https://img-v1.raydium.io/icon/${mint}.png`;
const raydiumPoolUrl = (poolId: string) => `https://raydium.io/clmm/create-position/?pool_id=${poolId}`;

const eyebrow = "font-data text-[10px] uppercase tracking-[0.14em] text-ink/60";
const chip = "inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 font-data text-[10px] uppercase tracking-[0.14em]";

function Stat({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={`flex items-center gap-1 ${eyebrow}`}>{label}</dt>
      <dd className="mt-2 text-lg font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * One pair as a cream card. The headline pill is the estimated fee APR of the highest-APR candidate range
 * (a bare figure: the "estimate" and low-confidence notes live in its tooltip); the range itself is a
 * separate field with no APR figure in it. Both read the same cached payload and the same pure resolver the
 * Create position modal uses for its "AI best" button, so the two always agree.
 */
function PairCard({
  pair, tokens, poolFeeAprHelp, onOpen,
}: {
  pair: RwaPair;
  tokens: Record<string, TokenMetadata>;
  poolFeeAprHelp: string;
  onOpen: () => void;
}) {
  const apr = usePoolRangeApr(pair.poolAddress);
  const summary = apr.status === "ready" ? highestRangeSummary(OPEN_RANGE_UI_PRESETS, apr.data) : null;
  const low = apr.status === "ready" && apr.data.sample.confidence === "low";
  const placeholder = apr.status === "loading" ? "…" : "—";
  const rangeLabel = summary
    ? OPEN_RANGE_UI_PRESETS.find((preset) => preset.id === summary.id)?.label ?? summary.label
    : placeholder;
  const wrappedIsA = pair.symbolA === pair.wrappedSymbol;
  const mints = wrappedIsA ? [pair.mintA, pair.mintB] : [pair.mintB, pair.mintA];
  const symbols = [pair.wrappedSymbol, pair.plainSymbol];

  return (
    <li className="flex min-w-0 flex-col rounded-[28px] bg-cream p-6 text-ink sm:p-7">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex shrink-0 -space-x-3">
            {mints.map((mint, index) => (
              <span key={mint} className="rounded-full bg-ink ring-2 ring-cream">
                <TokenIcon symbol={symbols[index]!} icon={tokens[mint]?.icon ?? raydiumIcon(mint)} />
              </span>
            ))}
          </span>
          <div className="min-w-0">
            <h3 className="text-xl font-medium tracking-[-0.02em]">
              {pair.wrappedSymbol}/{pair.plainSymbol}
            </h3>
            <p className="truncate text-xs text-ink/65" title={`${pair.nameA} / ${pair.nameB}`}>
              {pairIssuerLabel(pair.nameA, pair.nameB)}
            </p>
          </div>
        </div>
        <div className="shrink-0 sm:text-right">
          <p
            className={cn(
              "inline-flex items-baseline gap-1.5 whitespace-nowrap rounded-full px-5 py-2 text-[1.75rem] font-medium leading-none tracking-[-0.035em] tabular-nums",
              summary ? "bg-lemon shadow-[0_0_0_2.5px_var(--color-ink)]" : "bg-ink/10",
            )}
          >
            <span data-testid="highest-range-apr">
              {summary ? formatAprPct(summary.aprPct, false) : placeholder}
            </span>
            {summary && <span className="text-[0.5em] tracking-normal">APR</span>}
          </p>
          <p className={`mt-2.5 flex items-center gap-1 sm:justify-end ${eyebrow}`}>
            {HIGHEST_RANGE_APR_LABEL}
            {summary && (
              <InfoTip label="About Highest range APR" tone="light">
                {APR_ESTIMATE_CAVEAT}{low ? " Low confidence for this pool: thin or patchy recent trading." : ""}
              </InfoTip>
            )}
          </p>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-ink/20 pt-5 sm:grid-cols-3">
        <Stat label={<>
          {HIGHEST_RANGE_COLUMN_LABEL}
          {summary && <InfoTip label="About Highest range" placement="above" tone="light">{HIGHEST_RANGE_HELP}</InfoTip>}
        </>}>
          <span
            className={cn(
              "inline-block max-w-full truncate rounded-full px-3 py-1 align-top text-sm font-medium",
              summary ? "bg-lilac" : "bg-ink/10",
            )}
            data-testid="highest-range"
          >
            {rangeLabel}
          </span>
        </Stat>
        <Stat label="TVL">{money(pair.tvlUsd)}</Stat>
        <Stat label="24h vol">{money(pair.volume24hUsd)}</Stat>
        <Stat label="Fee">{pair.feeTierBps === null ? "—" : `${pair.feeTierBps} bps`}</Stat>
        <Stat label={<>
          Pool fee APR
          <InfoTip label="About Pool fee APR" placement="above" tone="light">{poolFeeAprHelp}</InfoTip>
        </>}>
          <span data-testid="pool-fee-apr">{pct(pair.estimatedFeeAprPct)}</span>
        </Stat>
      </dl>

      {(pair.token2022A || pair.token2022B || pair.freezeRisk) && (
        <div className="mt-5 flex flex-wrap gap-1.5">
          {(pair.token2022A || pair.token2022B) && (
            <span className={`${chip} bg-white`}>Token-2022</span>
          )}
          {pair.freezeRisk && (
            <span className={`${chip} bg-coral`}>Freeze risk</span>
          )}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-3 pt-6">
        <button
          type="button"
          className="group inline-flex h-12 items-center justify-between gap-4 rounded-full bg-ink pl-5 pr-1.5 text-sm font-semibold text-cream outline-none transition-transform hover:-translate-y-px focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]"
          onClick={onOpen}
        >
          Create position
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-lemon text-ink transition-transform group-hover:rotate-45">
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </span>
        </button>
        <Link
          href={buildPlanPath({
            poolId: pair.poolAddress,
            pair: `${pair.wrappedSymbol}/${pair.plainSymbol}`,
          })}
          className="inline-flex h-12 items-center rounded-full border border-ink/40 px-5 text-sm font-semibold outline-none transition-colors hover:border-ink focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]"
        >
          Plan this pool
        </Link>
        <a
          href={raydiumPoolUrl(pair.poolAddress)}
          target="_blank"
          rel="noreferrer"
          title={`Open pool ${pair.poolAddress} on Raydium`}
          className="ml-auto font-data text-[10px] tracking-[0.08em] text-ink/60 underline underline-offset-2 outline-none hover:text-ink focus-visible:text-ink"
        >
          {short(pair.poolAddress)}
        </a>
      </div>
    </li>
  );
}

export function RwaPairsPanel() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<RwaPairsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openPair, setOpenPair] = useState<OpenPositionPair | null>(null);
  const tokens = useTokenMetadata(data?.pairs.flatMap((pair) => [pair.mintA, pair.mintB]) ?? []);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/rwa-pairs?minTvl=0&maxPages=10&sortBy=estimatedFeeApr", {
        signal,
        headers: { Accept: "application/json" },
      });
      const body = (await response.json()) as RwaPairsResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || "Failed to load RWA pairs");
      if (!signal?.aborted) {
        setData(body);
        setError(null);
        setLoading(false);
      }
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
    if (!data || searchParams.get("open") !== "1") return;
    const pool = searchParams.get("pool");
    if (!pool) return;
    const pair = data.pairs.find((item) => item.poolAddress === pool);
    if (!pair) return;
    const timer = window.setTimeout(() => setOpenPair(toOpenPair(pair)), 0);
    return () => window.clearTimeout(timer);
  }, [data, searchParams]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    void load();
  };

  return (
    <section className="mt-3" aria-labelledby="rwa-pairs-heading">
      <div className="rounded-[28px] border border-white/12 bg-char p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-5">
          <div>
            <h2 id="rwa-pairs-heading" className="text-base font-semibold text-cream">
              Same-asset RWA CLMM pairs
            </h2>
            <p className="mt-2 max-w-2xl text-xs leading-5 text-smoke">
              Raydium concentrated pools where both sides are the same underlying (e.g. MSTRx/MSTR, NVDAx/NVDA),
              filtered by Jupiter tags (stocks|rwa) and the Backed xStocks whitelist. Create position swaps your chosen wallet asset into pool tokens as needed, then opens a new LP position and adds liquidity.
            </p>
          </div>
          <button
            className="inline-flex items-center justify-center gap-2 rounded-full border border-white/20 bg-transparent px-3 py-2 text-xs font-semibold text-cream/80 transition-colors hover:border-white/40 hover:bg-white/[0.04] disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={loading}
            onClick={refresh}
          >
            {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </div>

        {data && (
          <p className="mt-4 text-[11px] leading-5 text-smoke/70">
            {data.pairingRuleSummary} Yield: {data.estimatedFeeAprLabel} Scanned {data.scannedPools} pools
            ({data.pagesFetched} pages). Sorted by estimated fee APR.
          </p>
        )}

        {error && (
          <div role="alert" className="mt-6 rounded-2xl border border-white/20 bg-white/[0.04] p-4 text-sm text-cream/80">
            {error}
          </div>
        )}

        {loading && !data && (
          <p role="status" className="mt-8 inline-flex items-center gap-2 text-sm text-smoke">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Scanning Raydium CLMM pools…
          </p>
        )}

        {data && data.pairs.length === 0 && !loading && (
          <p className="mt-8 text-sm text-smoke">No same-asset RWA pairs found in the scanned range.</p>
        )}
      </div>

      {data && data.pairs.length > 0 && (
        <ul className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {data.pairs.map((pair) => (
            <PairCard
              key={pair.poolAddress}
              pair={pair}
              tokens={tokens}
              poolFeeAprHelp={data.estimatedFeeAprLabel}
              onOpen={() => setOpenPair(toOpenPair(pair))}
            />
          ))}
        </ul>
      )}

      {openPair && <OpenPositionModal pair={openPair} onClose={() => setOpenPair(null)} />}
    </section>
  );
}
