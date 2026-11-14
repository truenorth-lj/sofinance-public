import type { PositionPerformanceReport } from "@/lib/position-performance-report";

const CACHE_MS = 60_000;
/**
 * Performance reports read in this tab, shared by the Portfolio totals and the Performance overview: each report reads
 * the position's chain history, so one position is read once per minute however many places show it. A read already in
 * flight is joined, not repeated.
 */
const cache = new Map<string, { at: number; report: PositionPerformanceReport | null }>();
const inflight = new Map<string, Promise<PositionPerformanceReport | null>>();

export type ReportSource = { key: string; load: (signal: AbortSignal) => Promise<PositionPerformanceReport | null> };

/** A fresh cached report, or undefined. */
export function cachedReport(key: string): { report: PositionPerformanceReport | null } | undefined {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < CACHE_MS ? { report: hit.report } : undefined;
}

/**
 * Read one report (cached for a minute; a concurrent read joins). The read itself is not tied to one caller's lifetime,
 * so a caller that goes away does not cancel it for another one; callers drop a late result themselves.
 */
export function readReport(source: ReportSource): Promise<PositionPerformanceReport | null> {
  const hit = cachedReport(source.key);
  if (hit) return Promise.resolve(hit.report);
  const running = inflight.get(source.key);
  if (running) return running;
  const read = source.load(new AbortController().signal).then((report) => {
    cache.set(source.key, { at: Date.now(), report });
    return report;
  }).finally(() => { inflight.delete(source.key); });
  inflight.set(source.key, read);
  return read;
}

/** Tests only: forget every report. */
export function clearReportCache() { cache.clear(); inflight.clear(); }
