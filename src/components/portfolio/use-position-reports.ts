"use client";

import { useEffect, useRef, useState } from "react";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import { cachedReport, readReport, reportGeneration, type ReportSource } from "./report-cache";

export type LoadedReport = { report: PositionPerformanceReport | null; error: boolean };

/**
 * Performance reports for the Portfolio rows and totals, read one position at a time (each read costs several chain
 * history calls on the server), so numbers fill in progressively. `paused` stops new reads (e.g. while the Performance
 * overview reads the same positions); results arrive through the shared cache either way. `refresh`: bump it after
 * `invalidateReports` (Refresh, a confirmed compound) to read again; positions still cached return without a request,
 * and the numbers on screen stay until their new report arrives.
 */
export function usePositionReports(sources: readonly ReportSource[], { paused = false, refresh = 0 }: { paused?: boolean; refresh?: number } = {}): Record<string, LoadedReport> {
  const [loaded, setLoaded] = useState<Record<string, LoadedReport>>({});
  const keys = sources.map((item) => item.key).join("|");
  const latest = useRef(sources);
  // A failed read is not cached; it is tried again only after Refresh or a compound invalidated it, not on every re-run.
  const failedAt = useRef(new Map<string, number>());
  useEffect(() => { latest.current = sources; });
  useEffect(() => {
    if (!keys || paused) return;
    let live = true;
    const wanted = new Set(keys.split("|"));
    void (async () => {
      for (const item of latest.current) {
        if (!live) return;
        if (!wanted.has(item.key)) continue;
        if (failedAt.current.get(item.key) === reportGeneration(item.key)) continue;
        const generation = reportGeneration(item.key);
        try {
          const report = await readReport(item);
          if (!live) return;
          failedAt.current.delete(item.key);
          setLoaded((current) => current[item.key]?.report === report && !current[item.key]?.error ? current : { ...current, [item.key]: { report, error: false } });
        } catch {
          failedAt.current.set(item.key, generation);
          if (!live) return;
          setLoaded((current) => ({ ...current, [item.key]: { report: null, error: true } }));
        }
      }
    })();
    return () => { live = false; };
  }, [keys, paused, refresh]);
  // While paused, a report another reader cached still shows.
  const out: Record<string, LoadedReport> = {};
  for (const item of sources) {
    const own = loaded[item.key];
    const hit = own ?? (cachedReport(item.key) ? { report: cachedReport(item.key)!.report, error: false } : undefined);
    if (hit) out[item.key] = hit;
  }
  return out;
}
