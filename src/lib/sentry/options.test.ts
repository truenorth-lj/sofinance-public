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

describe("beforeSend route tag isolation", () => {
  const marker = "R6_LABELLED_SECRET_9";
  const sources = [
    { name: "request", fields: { request: { url: "https://local.invalid/api/request?token=hidden" }, transaction: "POST /api/transaction" }, route: "/api/request" },
    { name: "transaction", fields: { transaction: "POST /api/transaction?token=hidden" }, route: "/api/transaction" },
    { name: "existing tag", fields: {}, route: "/api/existing" },
  ];
  const keys = ["api-key", "%61pi-key", "%FF%61pi-key", "%25252561pi-key"];

  describe.each(sources)("$name", ({ fields, route }) => {
    it.each(keys.flatMap((key) => [false, true].map((throws) => ({ key, throws }))))(
      "classifies $key before reading its accessor (throws=$throws)",
      ({ key, throws }) => {
        const getter = vi.fn(() => {
          if (throws) throw new Error("tag getter must not run");
          return marker;
        });
        const tags = Object.assign(Object.create(null), { route: "/api/existing", design: "retry", error_class: "TypeError" });
        Object.defineProperty(tags, key, { enumerable: true, get: getter });
        const before = Object.getOwnPropertyDescriptors(tags);
        const output = sentryInitOptions().beforeSend({ type: undefined, ...structuredClone(fields), tags, message: "provider failed" });

        expect(getter).not.toHaveBeenCalled();
        expect(output.tags).toMatchObject({ route, design: "retry", error_class: "TypeError" });
        expect(output.tags?.[key === "api-key" || key === "%61pi-key" ? "api-key" : "[redacted-secret]"]).toBe("[redacted]");
        expect(Object.getPrototypeOf(output.tags)).toBeNull();
        // Compare identity as a boolean so the assertion library cannot inspect
        // the raw accessor-bearing object while suggesting equality matchers.
        expect(output.tags === tags).toBe(false);
        expect(Object.getOwnPropertyDescriptors(tags)).toEqual(before);
        expect(JSON.stringify(output)).not.toContain(marker);
        expect(getter).not.toHaveBeenCalled();
      },
    );

    it("does not materialize ordinary tag accessors", () => {
      const getter = vi.fn(() => "do not materialize");
      const tags = { route: "/api/existing", design: "retry" };
      Object.defineProperty(tags, "safeGetter", { enumerable: true, get: getter });
      const output = sentryInitOptions().beforeSend({ type: undefined, ...structuredClone(fields), tags });
      expect(getter).not.toHaveBeenCalled();
      expect(output.tags).toMatchObject({ route, design: "retry", safeGetter: "[unavailable]" });
    });

    it.each([false, true])("does not read an existing route accessor (throws=%s)", (throws) => {
      const getter = vi.fn(() => {
        if (throws) throw new Error("route getter must not run");
        return "/api/accessor";
      });
      const tags = { design: "retry" };
      Object.defineProperty(tags, "route", { enumerable: true, get: getter });
      const before = Object.getOwnPropertyDescriptors(tags);
      const output = sentryInitOptions().beforeSend({ type: undefined, ...structuredClone(fields), tags });
      expect(getter).not.toHaveBeenCalled();
      expect(output.tags?.route).toBe(route === "/api/existing" ? "[unavailable]" : route);
      expect(Object.getOwnPropertyDescriptors(tags)).toEqual(before);
    });
  });

  it("keeps inferred route precedence within the bounded tag copy", () => {
    const getter = vi.fn(() => marker);
    const tags: Record<string, string> = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`design${i}`, "retry"]));
    Object.defineProperty(tags, "%61pi-key", { enumerable: true, get: getter });
    tags.route = "/api/existing";
    const before = Object.getOwnPropertyDescriptors(tags);
    const output = sentryInitOptions().beforeSend({ type: undefined, tags, request: { url: "https://local.invalid/api/request" }, transaction: "POST /api/transaction" });
    expect(output.tags?.route).toBe("/api/request");
    expect(output.tags?.design0).toBe("retry");
    expect(output.tags?.truncated).toBe(true);
    expect(Object.keys(output.tags!)).toHaveLength(51);
    expect(getter).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptors(tags)).toEqual(before);
  });

  it("handles absent routes and a tag enumeration failure without copying placeholder characters", () => {
    expect(sentryInitOptions().beforeSend({ type: undefined, message: "ordinary" }).tags).toBeUndefined();
    const tags = new Proxy({}, { ownKeys() { throw new Error("unavailable tags"); } });
    const output = sentryInitOptions().beforeSend({ type: undefined, tags, request: { url: "https://local.invalid/api/request" } });
    expect(output.tags).toEqual({ route: "/api/request" });
  });

  describe.each(["minimal", "last resort"])("%s fallback", (fallback) => {
    it.each(["data", "accessor", "throwing accessor"])("isolates raw tags with a %s route", (kind) => {
      const secretGetter = vi.fn(() => { throw new Error("secret getter must not run"); });
      const routeGetter = vi.fn(() => {
        if (kind === "throwing accessor") throw new Error("route getter must not run");
        return `/api/test?api-key=${marker}`;
      });
      const tags = Object.create(null);
      Object.defineProperty(tags, "%61pi-key", { enumerable: true, get: secretGetter });
      Object.defineProperty(tags, "route", kind === "data"
        ? { enumerable: true, value: `/api/test?api-key=${marker}` }
        : { enumerable: true, get: routeGetter });
      const before = Object.getOwnPropertyDescriptors(tags);
      // A real primary failure before tag scrubbing, then optionally a real
      // minimal failure before tag handling. No scrubber mocks hide the path.
      const valueGetter = vi.fn(() => { throw new Error("exception value unavailable"); });
      const value = Object.defineProperty({ type: "Error" }, "value", { get: valueGetter });
      const event: ErrorEvent = { type: undefined, tags, exception: { values: [value] }, message: `Authorization: Bearer ${marker}`, contexts: { diagnostic: { design: "drop" } }, extra: { design: "drop" } };
      if (fallback === "last resort") Object.defineProperty(event, "user", { value: {}, writable: false });
      const output = sentryInitOptions().beforeSend(event);

      expect(valueGetter).toHaveBeenCalled();
      expect(secretGetter).not.toHaveBeenCalled();
      expect(routeGetter).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptors(tags)).toEqual(before);
      expect(output.tags).toEqual(kind === "data" ? { route: "/api/test?[redacted-secret]" } : {});
      expect(output.message).toBe(fallback === "minimal" ? "[redacted-secret]" : LAST_RESORT_SENTRY_MESSAGE);
      expect(output.contexts).toBeUndefined();
      expect(output.extra).toBeUndefined();
      expect(JSON.stringify(output)).not.toContain(marker);
    });
  });

  it.each(sources.slice(0, 2))("keeps the $name route through a real primary scrub failure", ({ fields, route }) => {
    const getter = vi.fn(() => { throw new Error("tag accessor must not run"); });
    const tags = { design: "retry" };
    Object.defineProperties(tags, {
      "%61pi-key": { enumerable: true, get: getter },
      route: { enumerable: true, get: getter },
    });
    const before = Object.getOwnPropertyDescriptors(tags);
    const value = Object.defineProperty({ type: "Error" }, "value", { get() { throw new Error("exception value unavailable"); } });
    const output = sentryInitOptions().beforeSend({ type: undefined, ...structuredClone(fields), tags, exception: { values: [value] }, contexts: { diagnostic: { design: "drop" } } });
    expect(getter).not.toHaveBeenCalled();
    expect(output.tags).toEqual({ route });
    expect(output.contexts).toBeUndefined();
    expect(output.exception).toBeUndefined();
    expect(Object.getOwnPropertyDescriptors(tags)).toEqual(before);
  });

  it("keeps a safe existing route if request route inference throws", () => {
    const getter = vi.fn(() => { throw new Error("request URL unavailable"); });
    const tags = { route: "/api/existing", design: "retry" };
    const request = Object.defineProperty({}, "url", { get: getter });
    const output = sentryInitOptions().beforeSend({ type: undefined, request, tags, message: "ordinary", contexts: { diagnostic: { design: "drop" } } });
    expect(getter).toHaveBeenCalled();
    expect(output.tags).toEqual({ route: "/api/existing" });
    expect(output.contexts).toBeUndefined();
    expect(tags).toEqual({ route: "/api/existing", design: "retry" });
  });
});
