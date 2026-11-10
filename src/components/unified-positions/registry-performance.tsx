"use client";

/**
 * Performance tab (PR9) for "My positions" rows served through the DEX registry: the adapter's report
 * (`POST /api/dex/<id>/performance`) drawn with the same summary and pool daily APR chart as the Raydium panel. Decided
 * from the descriptor only (no DEX id): the tab exists when `capabilities.performance` is supported, and the exit
 * estimate is greyed with `capabilities.exitPreview.reason` until a DEX supports it.
 */
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDexPerformance, type PositionPerformance } from "@/lib/dex/client";
import { PerformancePoolChart, PerformanceSummary, money } from "../position-performance-summary";
import { useTokenMetadata } from "../use-token-metadata";
import type { RegistryToolProps } from "./registry-tools";

const CARD = "mt-3 rounded-[28px] border border-white/12 bg-char p-5 sm:p-7";

type Loaded = { key: string; attempt: number; data: PositionPerformance | null; error: string | null };

export function RegistryPerformancePanel({ position, descriptor, capabilities, onPerformance, showStockPerformance = true }: Pick<RegistryToolProps, "position" | "descriptor" | "capabilities" | "onPerformance" | "showStockPerformance">) {
  const [attempt, setAttempt] = useState(0);
  const onPerformanceRef = useRef(onPerformance);
  useEffect(() => { onPerformanceRef.current = onPerformance; });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const metadata = useTokenMetadata([position.tokenA.id, position.tokenB.id]);
  useEffect(() => {
    const controller = new AbortController();
    fetchDexPerformance(descriptor, position.key, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setLoaded({ key: position.key, attempt, data, error: null });
        onPerformanceRef.current?.(position.key, { report: data.report ?? null, error: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ key: position.key, attempt, data: null, error: error instanceof Error && error.message ? error.message : "Performance could not be loaded." });
        onPerformanceRef.current?.(position.key, { report: null, error: true });
      });
    return () => controller.abort();
  }, [descriptor, position.key, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const current = loaded && loaded.key === position.key && loaded.attempt === attempt ? loaded : null;
  const report = current?.data?.report ?? null;
  const exitPreview = capabilities.exitPreview;

  return <section aria-label={showStockPerformance ? "Performance results" : "Position details"} data-testid="registry-performance" className={CARD}>
    <h3 className="mb-5 text-base font-semibold text-cream">{showStockPerformance ? "Performance results" : "Position details"}</h3>
    {!current ? <div role="status" className="flex items-center gap-2 text-sm text-smoke">
      <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />Loading performance…
    </div> : current.error ? <div className="space-y-3">
      <p role="alert" className="rounded-2xl border border-white/20 bg-white/[0.04] px-3 py-2 text-sm text-cream/80">{current.error}</p>
      <button type="button" onClick={retry} className="inline-flex items-center gap-2 rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink">Retry performance</button>
    </div> : report ? <PerformanceSummary data={report} embedded metadata={metadata} showStockPerformance={showStockPerformance} />
      : current.data ? <dl data-testid="registry-performance-summary" className="grid gap-2 text-sm text-cream/90 sm:grid-cols-2">
        <div><dt className="text-[11px] uppercase tracking-wide text-smoke">Current value (USD)</dt><dd>{money(current.data.currentValueUsd)}</dd></div>
        <div><dt className="text-[11px] uppercase tracking-wide text-smoke">PnL (USD)</dt><dd>{money(current.data.pnlUsd)}</dd></div>
      </dl> : null}
    {current?.data && !exitPreview.supported ? <div aria-disabled="true" data-testid="exit-preview-unavailable"
      className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] p-4 opacity-60">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-smoke">Exit estimate</h4>
      <p className="mt-1 text-xs leading-5 text-smoke">{exitPreview.reason}</p>
    </div> : null}
    <PerformancePoolChart poolId={position.poolId} data={report} />
  </section>;
}
