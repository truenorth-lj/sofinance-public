import type { PositionPerformanceReport } from "@/lib/position-performance-report";

const CACHE_MS = 60_000;
/**
 * Performance reports read in this tab, shared by the Portfolio totals and the Performance overview: each report reads
 * the position's chain history, so one position is read once per minute however many places show it. A read already in
 * flight is joined, not repeated.
 */
const cache = new Map<string, { at: number; report: PositionPerformanceReport | null }>();
const inflight = new Map<string, Promise<PositionPerformanceReport | null>>();
const generations = new Map<string, number>();
/** Bumped when every report is forgotten (Refresh), including positions that were never cached (failed reads). */
let allGeneration = 0;

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
  const generation = reportGeneration(source.key);
  const read = source.load(new AbortController().signal).then((report) => {
    // A read started before an invalidation must not put its older numbers back into the cache.
    if (reportGeneration(source.key) === generation) cache.set(source.key, { at: Date.now(), report });
    return report;
  }).finally(() => { if (inflight.get(source.key) === read) inflight.delete(source.key); });
  inflight.set(source.key, read);
  return read;
}

/** Bumped by `invalidateReports`: a reader re-tries a failed position only after its generation changed. */
export function reportGeneration(key: string): number { return allGeneration + (generations.get(key) ?? 0); }

/**
 * Forget reports so the next read goes to the server: every report (Refresh) or only the given positions (after a
 * confirmed compound changed that position). A read already in flight is no longer joined or cached.
 */
export function invalidateReports(keys?: readonly string[]) {
  if (!keys) allGeneration += 1;
  for (const key of keys ?? [...new Set([...cache.keys(), ...inflight.keys()])]) {
    cache.delete(key); inflight.delete(key); generations.set(key, (generations.get(key) ?? 0) + 1);
  }
}

/** Tests only: forget every report. */
export function clearReportCache() { cache.clear(); inflight.clear(); generations.clear(); allGeneration = 0; }
