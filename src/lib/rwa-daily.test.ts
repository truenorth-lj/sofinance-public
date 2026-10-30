import { describe, expect, it } from "vitest";
import {
  dailyWindow,
  validateHistoryRange,
  volumeWindowEnd,
} from "./rwa-daily";
import { validRwaAuthorization } from "./rwa-auth";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APR_SNAPSHOT_MAX_AGE_MS, RWA_PAIRS_STALE_MS, RWA_REFRESH_CRON, aprSnapshotDelayed, aprSnapshotExpired } from "./rwa-freshness";
import { payloadFixture } from "./range-apr/payload.fixture";

describe("RWA observation boundaries", () => {
  it("dates in Taipei and accepts only the morning capture window", () => {
    expect(dailyWindow(Date.parse("2026-10-13T23:00:00Z")).date).toBe(
      "2026-10-14",
    );
    expect(dailyWindow(Date.parse("2026-10-14T00:09:59Z")).eligible).toBe(
      false,
    );
    expect(dailyWindow(Date.parse("2026-10-14T00:10:00Z")).eligible).toBe(true);
    expect(dailyWindow(Date.parse("2026-10-14T01:09:59Z")).eligible).toBe(true);
    expect(dailyWindow(Date.parse("2026-10-14T01:10:00Z")).eligible).toBe(
      false,
    );
    expect(volumeWindowEnd(Date.parse("2026-10-13T23:00:00Z"))).toBe(
      "2026-10-13T00:00:00.000Z",
    );
  });
  it("rejects invalid dates, reverse ranges and more than 366 days", () => {
    expect(() => validateHistoryRange("2026-02-30", "2026-03-01")).toThrow();
    expect(() => validateHistoryRange("2026-10-14", "2026-10-13")).toThrow();
    expect(() => validateHistoryRange("2025-01-01", "2026-01-02")).toThrow();
    expect(() =>
      validateHistoryRange("2024-02-29", "2025-02-28"),
    ).not.toThrow();
  });
  it("fails closed on missing, weak or wrong authentication", () => {
    const secret = "a".repeat(64);
    expect(validRwaAuthorization(`Bearer ${secret}`, secret)).toBe(true);
    expect(validRwaAuthorization(`Bearer ${"b".repeat(64)}`, secret)).toBe(
      false,
    );
    expect(validRwaAuthorization("Bearer short", "short")).toBe(false);
    expect(validRwaAuthorization(null, secret)).toBe(false);
  });
  it("expires displayed estimates based on source time, not response time", () => {
    const payload = payloadFixture({
      freshness: {
        snapshotAt: "2026-10-14T01:00:00Z",
        chainObservedAt: "2026-10-14T00:15:00Z",
        stale: true,
      },
    });
    // A daily snapshot stays on screen until after the next day's run (00:15 UTC) plus grace.
    expect(aprSnapshotExpired(payload, Date.parse("2026-10-14T01:00:00Z"))).toBe(false);
    expect(aprSnapshotExpired(payload, Date.parse("2026-10-15T00:14:00Z"))).toBe(false);
    expect(aprSnapshotExpired(payload, Date.parse("2026-10-15T02:14:00Z"))).toBe(false);
    expect(aprSnapshotExpired(payload, Date.parse("2026-10-15T02:16:00Z"))).toBe(true);
    expect(aprSnapshotExpired(payloadFixture({ freshness: { snapshotAt: "not a date", stale: true } }), Date.now())).toBe(true);
  });
  it("keeps the display window longer than the production cron interval", () => {
    const vercel = JSON.parse(readFileSync(resolve("vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    const cron = vercel.crons.find((entry) => entry.path === "/api/internal/rwa-refresh");
    expect(cron?.schedule).toBe(RWA_REFRESH_CRON);
    // Daily, at a minute inside the 00:10–01:10 UTC (08:10–09:10 Taipei) daily-sample window.
    const [minute, hour, ...rest] = RWA_REFRESH_CRON.split(" ");
    expect(rest).toEqual(["*", "*", "*"]);
    expect(Number(hour) * 60 + Number(minute)).toBeGreaterThanOrEqual(10);
    expect(Number(hour) * 60 + Number(minute)).toBeLessThan(70);
    expect(APR_SNAPSHOT_MAX_AGE_MS).toBeGreaterThan(24 * 3_600_000);
  });
});

/** Minutes of the day a cron field set fires at. Supports any value, step (every n), single value, range and comma lists for minute and hour. */
function cronField(field: string, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    const [lo, hi] = range === "*" ? [0, max - 1] : range!.includes("-") ? range!.split("-").map(Number) : [Number(range), Number(range)];
    if (![lo, hi, step].every(Number.isInteger) || step < 1) throw new Error(`unsupported cron field ${field}`);
    for (let v = lo!; v <= hi!; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Longest gap between two runs of a daily-repeating cron (day/month/weekday fields must be `*`). */
function longestCronGapMs(schedule: string): number {
  const [minute, hour, ...rest] = schedule.trim().split(/\s+/);
  if (rest.join(" ") !== "* * *") throw new Error(`unsupported cron schedule ${schedule}`);
  const runs = cronField(hour!, 24).flatMap((h) => cronField(minute!, 60).map((m) => h * 60 + m)).sort((a, b) => a - b);
  const gaps = runs.map((run, i) => (i + 1 < runs.length ? runs[i + 1]! : runs[0]! + 1440) - run);
  return Math.max(...gaps) * 60_000;
}

describe("stale thresholds vs the refresh cron", () => {
  const vercel = JSON.parse(readFileSync(resolve("vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
  const schedule = vercel.crons.find((entry) => entry.path === "/api/internal/rwa-refresh")!.schedule;

  it("parses cron schedules into the longest gap between runs", () => {
    expect(longestCronGapMs("15 0 * * *")).toBe(24 * 3_600_000);
    expect(longestCronGapMs("*/15 * * * *")).toBe(15 * 60_000);
    expect(longestCronGapMs("0 0,6 * * *")).toBe(18 * 3_600_000);
  });

  it("server (/api/rwa-pairs) and client (7d APR) thresholds outlast the gap between vercel.json refresh runs", () => {
    const gap = longestCronGapMs(schedule);
    expect(RWA_PAIRS_STALE_MS).toBeGreaterThan(gap);
    expect(APR_SNAPSHOT_MAX_AGE_MS).toBeGreaterThan(gap);
  });

  // "Data delayed" on the pool cards / list comes from the per-pool `freshness.stale` (`aprSnapshotDelayed`).
  const run = "2026-10-30T00:15:30.000Z";
  const snapshot = { chainObservedAt: run, volumeObservedAt: run, windowEndUtc: "2026-10-30T00:00:00.000Z" };
  const at = (iso: string) => Date.parse(iso);

  it("a snapshot from the daily run is not delayed at any time before the next run (incl. 00:00–00:15 UTC)", () => {
    for (const now of ["2026-10-30T00:16:00Z", "2026-10-30T01:00:00Z", "2026-10-30T12:00:00Z", "2026-10-30T23:59:00Z",
      "2026-10-31T00:05:00Z", "2026-10-31T00:15:00Z"]) expect(aprSnapshotDelayed(snapshot, at(now)), now).toBe(false);
    expect(aprSnapshotDelayed(snapshot, at(run) + longestCronGapMs(schedule))).toBe(false);
  });

  it("is delayed once chain or volume data is older than 26h (a missed run), or timestamps are unreadable", () => {
    expect(aprSnapshotDelayed(snapshot, at(run) + APR_SNAPSHOT_MAX_AGE_MS + 1)).toBe(true);
    expect(aprSnapshotDelayed(snapshot, at("2026-11-01T00:00:00Z"))).toBe(true);
    expect(aprSnapshotDelayed({ ...snapshot, volumeObservedAt: "2026-10-28T23:00:00.000Z" }, at("2026-10-30T02:00:00Z"))).toBe(true);
    expect(aprSnapshotDelayed({ ...snapshot, chainObservedAt: "not a date" }, at("2026-10-30T02:00:00Z"))).toBe(true);
  });

  it("is delayed when the 7-day volume window is older than any run in the last 26h could have produced", () => {
    expect(aprSnapshotDelayed({ ...snapshot, windowEndUtc: "2026-10-28T00:00:00.000Z" }, at("2026-10-30T02:00:00Z"))).toBe(true);
    expect(aprSnapshotDelayed({ ...snapshot, windowEndUtc: "2026-10-29T00:00:00.000Z" }, at("2026-10-30T02:00:00Z"))).toBe(false);
  });
});
