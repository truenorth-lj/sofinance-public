import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureException, setTag, setExtra } = vi.hoisted(() => ({
  captureException: vi.fn(),
  setTag: vi.fn(),
  setExtra: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException,
  withScope: (callback: (scope: { setTag: typeof setTag; setExtra: typeof setExtra }) => void) => {
    callback({ setTag, setExtra });
  },
  getCurrentScope: () => ({ getScopeData: () => ({}) }),
  getActiveSpan: () => undefined,
  spanToJSON: () => ({})
}));

import { JupiterHttpError, JupiterUnavailableError } from "@sofinance/engine/jupiter/errors";
import { RpcUnavailableError } from "@sofinance/engine/rpc/errors";
import { CompoundSendError } from "../public-error";
import {
  captureApiRouteError,
  isUserRejectedError,
  resolveApiRoute,
  sentryErrorClass,
  shouldCaptureApiError,
} from "./capture";

beforeEach(() => {
  captureException.mockReset();
  setTag.mockReset();
  setExtra.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sentryErrorClass", () => {
  it("names Jupiter and RPC failures, including CompoundSendError causes", () => {
    expect(sentryErrorClass(new JupiterHttpError(429, "/swap/v1/quote"))).toBe("JupiterHttpError");
    expect(sentryErrorClass(new JupiterUnavailableError())).toBe("JupiterUnavailableError");
    expect(sentryErrorClass(new RpcUnavailableError())).toBe("RpcUnavailableError");
    expect(sentryErrorClass(new CompoundSendError(new RpcUnavailableError(), false))).toBe("RpcUnavailableError");
    expect(sentryErrorClass(new Error("plain"))).toBe("Error");
    expect(sentryErrorClass("string")).toBe("unknown");
  });
});

describe("shouldCaptureApiError", () => {
  it("reports 5xx and Jupiter/RPC upstream, not validation 4xx or user-rejected", () => {
    expect(shouldCaptureApiError(new Error("Invalid wallet address"), 400)).toBe(false);
    expect(shouldCaptureApiError(new Error("User rejected the request."), 400)).toBe(false);
    expect(isUserRejectedError(new Error("User rejected the request."))).toBe(true);
    expect(shouldCaptureApiError(new Error("Wallet scan failed"), 503)).toBe(true);
    expect(shouldCaptureApiError(new JupiterHttpError(429, "/swap/v1/quote"), 503)).toBe(true);
    expect(shouldCaptureApiError(new JupiterHttpError(400, "/swap/v1/quote"), 400)).toBe(false);
    expect(shouldCaptureApiError(new RpcUnavailableError(), 400)).toBe(true);
  });
});

describe("resolveApiRoute", () => {
  it("derives /api/wallet from the request URL, not a stale stack path", () => {
    const request = new Request("https://sofinancelab.xyz/api/wallet?wallet=abc");
    expect(resolveApiRoute({ request })).toBe("/api/wallet");
    expect(resolveApiRoute({
      route: "/api/rwa-pairs",
      request,
    })).toBe("/api/rwa-pairs");
    expect(resolveApiRoute({ request: { url: "https://example.com/api/wallet" } })).toBe("/api/wallet");
  });
});

describe("captureApiRouteError", () => {
  it("is a no-op when both DSN env vars are unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    vi.stubEnv("SENTRY_DSN", "");
    captureApiRouteError(new JupiterHttpError(503, "/swap/v1/quote"), {
      request: new Request("https://example.com/api/selected-quote"),
      status: 503,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("does not report validation 4xx even when a DSN is set", () => {
    vi.stubEnv("SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    captureApiRouteError(new Error("Invalid wallet address"), {
      request: new Request("https://example.com/api/wallet"),
      status: 400,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures 5xx with a request-derived route and error_class", () => {
    vi.stubEnv("SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    const error = new JupiterHttpError(429, "/swap/v1/quote");
    captureApiRouteError(error, {
      request: new Request("https://example.com/api/selected-quote"),
      fallback: "Quote failed",
      status: 503,
    });
    expect(captureException).toHaveBeenCalledWith(error);
    expect(setTag).toHaveBeenCalledWith("route", "/api/selected-quote");
    expect(setTag).toHaveBeenCalledWith("error_class", "JupiterHttpError");
    expect(setExtra).toHaveBeenCalledWith(
      "public_message",
      expect.not.stringMatching(/api[_-]?key|https?:\/\//i),
    );
  });
});
