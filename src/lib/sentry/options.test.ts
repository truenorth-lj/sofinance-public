import { afterEach, describe, expect, it, vi } from "vitest";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { LAST_RESORT_SENTRY_MESSAGE, sentryInitOptions } from "./options";
import * as scrub from "./scrub";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sentryInitOptions", () => {
  it("disables the SDK and replay when DSN is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    vi.stubEnv("SENTRY_DSN", "");
    const options = sentryInitOptions();
    expect(options.enabled).toBe(false);
    expect(options.dsn).toBeUndefined();
    expect(options.sendDefaultPii).toBe(false);
    expect(options.dataCollection.userInfo).toBe(false);
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

  it("returns a stripped event when beforeSend internals throw", () => {
    vi.stubEnv("SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    vi.spyOn(scrub, "scrubSentryEvent").mockImplementation(() => {
      throw new Error("non-string replace");
    });
    const options = sentryInitOptions();
    const explodingHeaders = new Proxy({} as Record<string, unknown>, {
      ownKeys() {
        throw new Error("headers.ownKeys");
      },
      get() {
        throw new Error("headers.get");
      },
      getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true, value: undefined };
      },
    });
    const event = options.beforeSend({
      message: "Raydium CLMM pool account does not exist",
      exception: { values: [{ type: "Error", value: "Raydium CLMM pool account does not exist" }] },
      tags: { route: "/api/pool-range-apr", error_class: "Error" },
      request: {
        url: "https://sofinancelab.xyz/api/pool-range-apr?poolId=11111111111111111111111111111112",
        method: "GET",
        headers: explodingHeaders,
        env: { REMOTE_ADDR: "198.51.100.10" },
        query_string: "poolId=11111111111111111111111111111112",
        cookies: { session: "abc" },
      },
      user: { ip_address: "198.51.100.10" },
    } as unknown as ErrorEvent);

    expect(event).toBeTruthy();
    expect(event?.exception?.values?.[0]?.type).toBe("Error");
    expect(event?.exception?.values?.[0]?.value).toBe("Raydium CLMM pool account does not exist");
    expect(event?.tags?.route).toBe("/api/pool-range-apr");
    expect(event?.request?.headers).toBeUndefined();
    expect(event?.request?.env).toBeUndefined();
    expect(event?.request?.query_string).toBeUndefined();
    expect(event?.request?.cookies).toBeUndefined();
    expect(event?.user).toBeUndefined();
    expect(event?.request?.url).not.toContain("poolId=");
    expect(event?.request?.method).toBe("GET");
  });

  it("returns only a generic message and route when prepare and minimal both throw", () => {
    vi.stubEnv("SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    vi.spyOn(scrub, "scrubSentryEvent").mockImplementation(() => {
      throw new Error("prepare boom");
    });
    vi.spyOn(scrub, "minimalSentryEvent").mockImplementation(() => {
      throw new Error("minimal boom");
    });
    const options = sentryInitOptions();
    const event = options.beforeSend({
      message: "Raydium CLMM pool account does not exist",
      exception: {
        values: [{ type: "Error", value: "leak https://mainnet.helius-rpc.com/example-key" }],
      },
      tags: { route: "/api/pool-range-apr" },
      user: { geo: { city: "San Francisco" }, ip_address: "198.51.100.10" },
    } as unknown as ErrorEvent);

    expect(event).toBeTruthy();
    expect(event?.message).toBe(LAST_RESORT_SENTRY_MESSAGE);
    expect(event?.tags).toEqual({ route: "/api/pool-range-apr" });
    expect(event?.exception).toBeUndefined();
    expect(event?.user).toBeUndefined();
    expect(event?.request).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("helius");
    expect(JSON.stringify(event)).not.toContain("Raydium");
    expect(JSON.stringify(event)).not.toContain("San Francisco");
  });

  it("scrubs HTTP breadcrumbs at capture time via beforeBreadcrumb", () => {
    vi.stubEnv("SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    const options = sentryInitOptions();
    const crumb = options.beforeBreadcrumb({
      category: "http",
      message: "POST https://mainnet.helius-rpc.com/example-key",
      data: {
        url: "https://mainnet.helius-rpc.com/example-key",
        method: "POST",
        "url.query": "api-key=secret123",
      },
    } as Breadcrumb);

    expect(crumb).toBeTruthy();
    expect(crumb?.message).toContain("[redacted-url]");
    expect(crumb?.data?.url).toBe("[redacted-url]");
    expect(JSON.stringify(crumb)).not.toContain("helius");
    expect(JSON.stringify(crumb)).not.toContain("secret123");
  });
});
