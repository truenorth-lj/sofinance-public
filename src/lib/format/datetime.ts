/** Display timestamps in en-US, UTC, so server and client HTML match regardless of browser locale or time zone. */

function utcMs(value: string | number | Date): number | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const utcTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const utcTimeWithSeconds = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

const utcDateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "2:22 PM UTC"; with seconds, "2:22:17 PM UTC". Empty when the instant is unparsable. */
export function formatUtcTime(value: string | number | Date, options: { seconds?: boolean } = {}): string {
  const ms = utcMs(value);
  if (ms === null) return "";
  const clock = (options.seconds ? utcTimeWithSeconds : utcTime).format(new Date(ms));
  return `${clock} UTC`;
}

/** "Nov 25, 2026, 2:22 PM UTC". Empty when the instant is unparsable. */
export function formatUtcDateTime(value: string | number | Date): string {
  const ms = utcMs(value);
  if (ms === null) return "";
  return `${utcDateTime.format(new Date(ms))} UTC`;
}
