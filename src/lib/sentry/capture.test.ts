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
}));

import { JupiterHttpError, JupiterUnavailableError } from "@sofinance/engine/jupiter/errors";
import { RpcUnavailableError } from "@sofinance/engine/rpc/errors";
import { CompoundSendError } from "../public-error";
import { captureApiRouteError, routeFromCallerStack, sentryErrorClass } from "./capture";

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

describe("routeFromCallerStack", () => {
  it("extracts the App Router API path from a stack frame", () => {
    const stack = [
      "Error",
      "    at captureApiRouteError (/workspace/src/lib/sentry/capture.ts:30:11)",
      "    at apiError (/workspace/src/lib/api-response.ts:24:3)",
      "    at POST (/workspace/src/app/api/selected-quote/route.ts:18:12)",
    ].join("\n");
    expect(routeFromCallerStack(stack)).toBe("/api/selected-quote");
    expect(routeFromCallerStack("Error\n    at POST (src/app/api/lp-decision/exit-preview/route.ts:12:3)"))
      .toBe("/api/lp-decision/exit-preview");
  });
});

describe("captureApiRouteError", () => {
  it("is a no-op when both DSN env vars are unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    vi.stubEnv("SENTRY_DSN", "");
    captureApiRouteError(new JupiterHttpError(503, "/swap/v1/quote"), { route: "/api/selected-quote" });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures with route and error_class tags and a sanitized public message", () => {
    vi.stubEnv("SENTRY_DSN", "https://key@o1.ingest.us.sentry.io/1");
    const error = new JupiterHttpError(429, "/swap/v1/quote");
    captureApiRouteError(error, { route: "/api/selected-quote", fallback: "Quote failed" });
    expect(captureException).toHaveBeenCalledWith(error);
    expect(setTag).toHaveBeenCalledWith("route", "/api/selected-quote");
    expect(setTag).toHaveBeenCalledWith("error_class", "JupiterHttpError");
    expect(setExtra).toHaveBeenCalledWith(
      "public_message",
      expect.not.stringMatching(/api[_-]?key|https?:\/\//i),
    );
  });
});
