import { describe, expect, it } from "vitest";
import { formatUtcDateTime, formatUtcTime } from "./datetime";
import { delayedSnapshotTitle, utcMinuteLabel } from "@/lib/snapshot-updated";
import { formatUtcDate } from "@/components/plan/format";

const INSTANT = "2026-11-25T14:22:17.000Z";
const MS = Date.parse(INSTANT);

const ENVIRONMENTS = [
  { locale: "zh-TW", timeZone: "Asia/Taipei" },
  { locale: "de-DE", timeZone: "Europe/Berlin" },
] as const;

describe("UTC display formatters", () => {
  it("prints en-US UTC clock, datetime and snapshot labels", () => {
    expect(formatUtcTime(INSTANT)).toBe("2:22 PM UTC");
    expect(formatUtcTime(MS)).toBe("2:22 PM UTC");
    expect(formatUtcTime(new Date(MS))).toBe("2:22 PM UTC");
    expect(formatUtcTime(INSTANT, { seconds: true })).toBe("2:22:17 PM UTC");
    expect(formatUtcDateTime(INSTANT)).toBe("Nov 25, 2026, 2:22 PM UTC");
    expect(utcMinuteLabel(INSTANT)).toBe("2026-11-25 14:22 UTC");
    expect(delayedSnapshotTitle(INSTANT)).toBe("Snapshot from 2026-11-25 14:22 UTC");
    expect(formatUtcDate(MS + 90 * 86_400_000)).toBe("Feb 23, 2027");
  });

  it("returns the same string under zh-TW and de-DE with a non-UTC zone, unlike an unpinned formatter", () => {
    const unpinned = ENVIRONMENTS.map(({ locale, timeZone }) =>
      new Date(MS).toLocaleTimeString(locale, { timeZone, hour: "2-digit", minute: "2-digit" }),
    );
    expect(new Set(unpinned).size).toBeGreaterThan(1);
    expect(unpinned).not.toContain("2:22 PM UTC");

    const pinned = ENVIRONMENTS.flatMap(({ locale, timeZone }) => {
      // The default locale and zone are what a Windows Chrome session would pass if we called
      // toLocaleString() with no options. Our helpers must ignore both.
      void locale;
      void timeZone;
      return [
        formatUtcTime(INSTANT),
        formatUtcTime(INSTANT, { seconds: true }),
        formatUtcDateTime(INSTANT),
        utcMinuteLabel(INSTANT),
        delayedSnapshotTitle(INSTANT),
        formatUtcDate(MS),
      ];
    });
    expect(pinned).toEqual([
      "2:22 PM UTC",
      "2:22:17 PM UTC",
      "Nov 25, 2026, 2:22 PM UTC",
      "2026-11-25 14:22 UTC",
      "Snapshot from 2026-11-25 14:22 UTC",
      "Nov 25, 2026",
      "2:22 PM UTC",
      "2:22:17 PM UTC",
      "Nov 25, 2026, 2:22 PM UTC",
      "2026-11-25 14:22 UTC",
      "Snapshot from 2026-11-25 14:22 UTC",
      "Nov 25, 2026",
    ]);
  });

  it("treats an unparsable or epoch time as empty", () => {
    expect(formatUtcTime("")).toBe("");
    expect(formatUtcTime(0)).toBe("");
    expect(formatUtcDateTime("not-a-date")).toBe("");
    expect(utcMinuteLabel("not-a-date")).toBeNull();
    expect(delayedSnapshotTitle("not-a-date")).toBeUndefined();
  });
});
