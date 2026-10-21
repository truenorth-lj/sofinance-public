import { afterEach, describe, expect, it, vi } from "vitest";
import { isSentryEnabled, resolveSentryDsn, sentryTracesSampleRate } from "./runtime";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Sentry DSN gating", () => {
  it("is a no-op when NEXT_PUBLIC_SENTRY_DSN and SENTRY_DSN are unset", () => {
    expect(resolveSentryDsn({})).toBeUndefined();
    expect(isSentryEnabled({})).toBe(false);
    expect(resolveSentryDsn({ NEXT_PUBLIC_SENTRY_DSN: "  ", SENTRY_DSN: "" })).toBeUndefined();
  });

  it("accepts NEXT_PUBLIC_SENTRY_DSN or SENTRY_DSN", () => {
    expect(resolveSentryDsn({ NEXT_PUBLIC_SENTRY_DSN: "https://key@o1.ingest.us.sentry.io/1" }))
      .toBe("https://key@o1.ingest.us.sentry.io/1");
    expect(resolveSentryDsn({ SENTRY_DSN: "https://key@o1.ingest.us.sentry.io/2" }))
      .toBe("https://key@o1.ingest.us.sentry.io/2");
    expect(isSentryEnabled({ SENTRY_DSN: "https://key@o1.ingest.us.sentry.io/2" })).toBe(true);
  });

  it("prefers NEXT_PUBLIC_SENTRY_DSN when both are set", () => {
    expect(resolveSentryDsn({
      NEXT_PUBLIC_SENTRY_DSN: "https://public@o1.ingest.us.sentry.io/1",
      SENTRY_DSN: "https://server@o1.ingest.us.sentry.io/2",
    })).toBe("https://public@o1.ingest.us.sentry.io/1");
  });
});

describe("tracesSampleRate", () => {
  it("defaults to 0.1 and is env-overridable, clamped to [0, 1]", () => {
    expect(sentryTracesSampleRate({})).toBe(0.1);
    expect(sentryTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "0.25" })).toBe(0.25);
    expect(sentryTracesSampleRate({ NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: "1" })).toBe(1);
    expect(sentryTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "2" })).toBe(1);
    expect(sentryTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "-1" })).toBe(0.1);
    expect(sentryTracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "nope" })).toBe(0.1);
  });
});
