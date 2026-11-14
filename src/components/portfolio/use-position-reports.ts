"use client";

import { useEffect, useRef, useState } from "react";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import { cachedReport, readReport, type ReportSource } from "./report-cache";

export type LoadedReport = { report: PositionPerformanceReport | null; error: boolean };

/**
 * Performance reports for the Portfolio rows and totals, read one position at a time (each read costs several chain
 * history calls on the server), so numbers fill in progressively. `paused` stops new reads (e.g. while the Performance
 * overview reads the same positions); results arrive through the shared cache either way.
 */
export function usePositionReports(sources: readonly ReportSource[], { paused = false }: { paused?: boolean } = {}): Record<string, LoadedReport> {
  const [loaded, setLoaded] = useState<Record<string, LoadedReport>>({});
  const keys = sources.map((item) => item.key).join("|");
  const latest = useRef(sources);
  useEffect(() => { latest.current = sources; });
  useEffect(() => {
    if (!keys || paused) return;
    let live = true;
    const wanted = new Set(keys.split("|"));
    void (async () => {
      for (const item of latest.current) {
        if (!live) return;
        if (!wanted.has(item.key)) continue;
        try {
          const report = await readReport(item);
          if (!live) return;
          setLoaded((current) => current[item.key]?.report === report && !current[item.key]?.error ? current : { ...current, [item.key]: { report, error: false } });
        } catch {
          if (!live) return;
          setLoaded((current) => ({ ...current, [item.key]: { report: null, error: true } }));
        }
      }
    })();
    return () => { live = false; };
  }, [keys, paused]);
  // While paused, a report another reader cached still shows.
  const out: Record<string, LoadedReport> = {};
  for (const item of sources) {
    const own = loaded[item.key];
    const hit = own ?? (cachedReport(item.key) ? { report: cachedReport(item.key)!.report, error: false } : undefined);
    if (hit) out[item.key] = hit;
  }
  return out;
}
