import { describe, expect, it } from "vitest";
import {
  dailyWindow,
  validateHistoryRange,
  volumeWindowEnd,
} from "./rwa-daily";
import { validRwaAuthorization } from "./rwa-auth";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APR_SNAPSHOT_MAX_AGE_MS, RWA_REFRESH_CRON, aprSnapshotExpired } from "./rwa-freshness";
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
