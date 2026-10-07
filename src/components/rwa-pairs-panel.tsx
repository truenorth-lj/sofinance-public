"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";

type RwaPair = {
  poolAddress: string;
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

export function RwaPairsPanel() {
  const [data, setData] = useState<RwaPairsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  const refresh = () => {
    setLoading(true);
    setError(null);
    void load();
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-[#111d2c]/95 p-4 sm:p-5" aria-labelledby="rwa-pairs-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="rwa-pairs-heading" className="text-sm font-semibold">Same-asset RWA CLMM pairs</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-400">
            Raydium concentrated pools where both sides are the same underlying (e.g. MSTRx/MSTR, NVDAx/NVDA),
            filtered by Jupiter tags (stocks|rwa) and the Backed xStocks whitelist. Read-only — does not open positions.
          </p>
        </div>
        <Button variant="secondary" className="px-3 py-2 text-xs" disabled={loading} onClick={refresh}>
          {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      {data && (
        <p className="mt-3 text-[11px] leading-5 text-slate-500">
          {data.pairingRuleSummary} Yield: {data.estimatedFeeAprLabel} Scanned {data.scannedPools} pools
          ({data.pagesFetched} pages). Sorted by estimated fee APR.
        </p>
      )}

      {error && (
        <div role="alert" className="mt-4 rounded-xl border border-rose-400/25 bg-rose-400/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {loading && !data && (
        <p role="status" className="mt-6 inline-flex items-center gap-2 text-sm text-sky-300">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Scanning Raydium CLMM pools…
        </p>
      )}

      {data && data.pairs.length === 0 && !loading && (
        <p className="mt-6 text-sm text-slate-400">No same-asset RWA pairs found in the scanned range.</p>
      )}

      {data && data.pairs.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 text-slate-400">
                <th className="py-2 pr-3 font-medium">Pair</th>
                <th className="py-2 pr-3 font-medium">Est. fee APR</th>
                <th className="py-2 pr-3 font-medium">Raydium APR</th>
                <th className="py-2 pr-3 font-medium">TVL</th>
                <th className="py-2 pr-3 font-medium">24h vol</th>
                <th className="py-2 pr-3 font-medium">Fee</th>
                <th className="py-2 pr-3 font-medium">Flags</th>
                <th className="py-2 font-medium">Pool</th>
              </tr>
            </thead>
            <tbody>
              {data.pairs.map((pair) => (
                <tr key={pair.poolAddress} className="border-b border-white/5 align-top text-slate-200">
                  <td className="py-3 pr-3">
                    <div className="font-semibold text-sky-200">
                      {pair.wrappedSymbol}/{pair.plainSymbol}
                    </div>
                    <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-slate-500" title={`${pair.nameA} / ${pair.nameB}`}>
                      {pair.nameA} / {pair.nameB}
                    </div>
                  </td>
                  <td className="py-3 pr-3 font-medium tabular-nums text-emerald-300">{pct(pair.estimatedFeeAprPct)}</td>
                  <td className="py-3 pr-3 tabular-nums text-slate-300">{pct(pair.raydiumFeeApr24h)}</td>
                  <td className="py-3 pr-3 tabular-nums">{money(pair.tvlUsd)}</td>
                  <td className="py-3 pr-3 tabular-nums">{money(pair.volume24hUsd)}</td>
                  <td className="py-3 pr-3 tabular-nums">
                    {pair.feeTierBps === null ? "—" : `${pair.feeTierBps} bps`}
                  </td>
                  <td className="py-3 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {(pair.token2022A || pair.token2022B) && (
                        <span className="rounded-full bg-violet-400/15 px-2 py-0.5 text-[10px] text-violet-200">Token-2022</span>
                      )}
                      {pair.freezeRisk && (
                        <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] text-amber-200">Freeze risk</span>
                      )}
                    </div>
                  </td>
                  <td className="py-3">
                    <a
                      className="inline-flex items-center gap-1 text-sky-300 underline"
                      href={`https://raydium.io/clmm/create-position/?pool_id=${pair.poolAddress}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(pair.poolAddress)} <ArrowUpRight className="h-3 w-3" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
