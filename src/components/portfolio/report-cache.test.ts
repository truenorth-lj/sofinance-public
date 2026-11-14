import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import { cachedReport, clearReportCache, invalidateReports, readReport, reportGeneration } from "./report-cache";

const report = (n: number) => ({ positionMint: String(n) }) as unknown as PositionPerformanceReport;
beforeEach(() => clearReportCache());

describe("report cache", () => {
  it("reads once per minute, joins a read in flight, and reads again after invalidation", async () => {
    let n = 0;
    const load = vi.fn(async () => report(++n));
    const [a, b] = await Promise.all([readReport({ key: "k", load }), readReport({ key: "k", load })]);
    expect(a).toBe(b); expect(load).toHaveBeenCalledTimes(1);
    expect(await readReport({ key: "k", load })).toBe(a); expect(load).toHaveBeenCalledTimes(1);
    invalidateReports(["k"]);
    expect(cachedReport("k")).toBeUndefined();
    expect(await readReport({ key: "k", load })).toEqual(report(2)); expect(load).toHaveBeenCalledTimes(2);
  });
  it("invalidating one position keeps the others; invalidating all forgets every one, even never-cached ones", async () => {
    await readReport({ key: "a", load: async () => report(1) });
    await readReport({ key: "b", load: async () => report(2) });
    invalidateReports(["a"]);
    expect(cachedReport("a")).toBeUndefined(); expect(cachedReport("b")).toBeDefined();
    const before = reportGeneration("never-read");
    invalidateReports();
    expect(cachedReport("b")).toBeUndefined();
    expect(reportGeneration("never-read")).toBeGreaterThan(before);
  });
  it("a read started before an invalidation does not put its older numbers back", async () => {
    let finish!: (value: PositionPerformanceReport) => void;
    const old = readReport({ key: "k", load: () => new Promise((resolve) => { finish = resolve; }) });
    invalidateReports(["k"]);
    finish(report(1)); await old;
    expect(cachedReport("k")).toBeUndefined();
  });
});
