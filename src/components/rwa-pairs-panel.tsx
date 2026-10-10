"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { PoolAprSparkline } from "./pool-daily-apr-panel";
import { LpDecisionBuilder } from "./lp-decision-builder";
import { OpenPositionModal } from "./open-position-modal";
import type { OpenPositionPair } from "./use-open-position-controller";

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

export function RwaPairsPanel() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<RwaPairsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decisionPair, setDecisionPair] = useState<RwaPair | null>(null);
  const [openPair, setOpenPair] = useState<OpenPositionPair | null>(null);

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
    const timer = window.setTimeout(() => {
      setOpenPair({
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
    }, 0);
    return () => window.clearTimeout(timer);
  }, [data, searchParams]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    void load();
  };

  return (
    <section 
      className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-6 sm:p-8" 
      aria-labelledby="rwa-pairs-heading"
    >
      <LpDecisionBuilder poolId={decisionPair?.poolAddress} contextLabel={decisionPair ? `RWA 池 ${decisionPair.symbolA}/${decisionPair.symbolB}` : undefined} />
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-800/50 pb-5">
        <div>
          <h2 id="rwa-pairs-heading" className="text-base font-semibold text-neutral-100">
            Same-asset RWA CLMM pairs
          </h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-neutral-500">
            Raydium concentrated pools where both sides are the same underlying (e.g. MSTRx/MSTR, NVDAx/NVDA),
            filtered by Jupiter tags (stocks|rwa) and the Backed xStocks whitelist. Add liquidity opens a new CLMM position in SoFinance.
          </p>
        </div>
        <button 
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-700 bg-transparent px-3 py-2 text-xs font-semibold text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={loading} 
          onClick={refresh}
        >
          {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </div>

      {data && (
        <p className="mt-4 text-[11px] leading-5 text-neutral-600">
          {data.pairingRuleSummary} Yield: {data.estimatedFeeAprLabel} Daily APR sparklines (top 8 rows) use
          GeckoTerminal volume × Raydium feeRate ÷ Raydium daily TVL, cached 1h — not Raydium-published daily
          feeApr. Scanned {data.scannedPools} pools ({data.pagesFetched} pages). Sorted by estimated fee APR.
        </p>
      )}

      {error && (
        <div role="alert" className="mt-6 rounded-xl border border-neutral-700 bg-neutral-900/50 p-4 text-sm text-neutral-300">
          {error}
        </div>
      )}

      {loading && !data && (
        <p role="status" className="mt-8 inline-flex items-center gap-2 text-sm text-neutral-400">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Scanning Raydium CLMM pools…
        </p>
      )}

      {data && data.pairs.length === 0 && !loading && (
        <p className="mt-8 text-sm text-neutral-500">No same-asset RWA pairs found in the scanned range.</p>
      )}

      {data && data.pairs.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-neutral-800/60">
                <th className="pb-3 pr-4 font-semibold text-neutral-400">Pair</th>
                <th className="pb-3 pr-4 font-semibold text-neutral-400">Est. fee APR</th>
                <th className="pb-3 pr-4 font-semibold text-neutral-400">Daily APR</th>
                <th className="pb-3 pr-4 font-semibold text-neutral-400">Raydium APR</th>
                <th className="pb-3 pr-4 font-semibold text-neutral-400">TVL</th>
                <th className="pb-3 pr-4 font-semibold text-neutral-400">24h vol</th>
                <th className="pb-3 pr-4 font-semibold text-neutral-400">Fee</th>
                <th className="pb-3 pr-4 font-semibold text-neutral-400">Flags</th>
                <th className="pb-3 font-semibold text-neutral-400">Liquidity</th>
              </tr>
            </thead>
            <tbody>
              {data.pairs.map((pair, index) => (
                <tr key={pair.poolAddress} className="border-b border-neutral-800/30 align-top">
                  <td className="py-4 pr-4">
                    <div className="font-semibold text-neutral-100">
                      {pair.wrappedSymbol}/{pair.plainSymbol}
                    </div>
                    <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-neutral-600" title={`${pair.nameA} / ${pair.nameB}`}>
                      {pair.nameA} / {pair.nameB}
                    </div>
                  </td>
                  <td className="py-4 pr-4 font-semibold tabular-nums text-neutral-100">{pct(pair.estimatedFeeAprPct)}</td>
                  <td className="py-4 pr-4">
                    {index < 8 ? <PoolAprSparkline poolId={pair.poolAddress} /> : <span className="text-neutral-600">—</span>}
                  </td>
                  <td className="py-4 pr-4 tabular-nums text-neutral-300">{pct(pair.raydiumFeeApr24h)}</td>
                  <td className="py-4 pr-4 tabular-nums text-neutral-300">{money(pair.tvlUsd)}</td>
                  <td className="py-4 pr-4 tabular-nums text-neutral-300">{money(pair.volume24hUsd)}</td>
                  <td className="py-4 pr-4 tabular-nums text-neutral-300">
                    {pair.feeTierBps === null ? "—" : `${pair.feeTierBps} bps`}
                  </td>
                  <td className="py-4 pr-4">
                    <div className="flex flex-wrap gap-1">
                      {(pair.token2022A || pair.token2022B) && (
                        <span className="rounded-full border border-neutral-700 bg-neutral-800/50 px-2 py-0.5 text-[10px] text-neutral-400">Token-2022</span>
                      )}
                      {pair.freezeRisk && (
                        <span className="rounded-full border border-neutral-700 bg-neutral-800/50 px-2 py-0.5 text-[10px] text-neutral-400">Freeze risk</span>
                      )}
                    </div>
                  </td>
                  <td className="py-4">
                    <button
                      type="button"
                      className="rounded-lg border border-neutral-700 px-2.5 py-1 text-[11px] font-semibold text-neutral-200 hover:border-neutral-500"
                      onClick={() => setOpenPair({
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
                      })}
                    >
                      Add liquidity
                    </button>
                    <button type="button" className="mt-2 block text-xs text-sky-300" onClick={() => { setDecisionPair(pair); document.getElementById("lp-decision")?.scrollIntoView({ behavior: "smooth" }); }}>唯讀情境試算</button>
                    <div className="mt-1 font-mono text-[10px] text-neutral-600">{short(pair.poolAddress)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openPair && <OpenPositionModal pair={openPair} onClose={() => setOpenPair(null)} />}
    </section>
  );
}
