import { afterEach, describe, expect, it, vi } from "vitest";
import { sentryInitOptions } from "./options";
import type { ErrorEvent } from "@sentry/nextjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sentryInitOptions", () => {
  it("disables the SDK and replay when DSN is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    vi.stubEnv("SENTRY_DSN", "");
    const options = sentryInitOptions();
    expect(options.enabled).toBe(false);
    expect(options.dsn).toBeUndefined();
    expect(options.sendDefaultPii).toBe(false);
    expect(options.replaysSessionSampleRate).toBe(0);
    expect(options.replaysOnErrorSampleRate).toBe(0);
    expect(options.tracesSampleRate).toBe(0.1);
  });

  it("enables the SDK from SENTRY_DSN and scrubs events in beforeSend", () => {
    vi.stubEnv("SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    const options = sentryInitOptions();
    expect(options.enabled).toBe(true);
    expect(options.dsn).toBe("https://key@o1.ingest.us.sentry.io/1");
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const event = options.beforeSend({
      message: `failed for ${wallet}`,
      tags: { route: "/api/rwa-pairs" },
      request: {
        url: "https://sofinancelab.xyz/api/wallet?wallet=abc",
        headers: {
          "X-Vercel-Protection-Bypass": "bypass-secret",
          "X-Forwarded-For": "198.51.100.10",
        },
      },
      user: { ip_address: "198.51.100.10" },
    } as unknown as ErrorEvent);
    expect(event?.message).toContain("[redacted-address]");
    expect(event?.message).not.toContain(wallet);
    expect(event?.tags?.route).toBe("/api/wallet");
    expect(event?.user).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("bypass-secret");
    expect(JSON.stringify(event)).not.toContain("198.51.100.10");
  });
});
