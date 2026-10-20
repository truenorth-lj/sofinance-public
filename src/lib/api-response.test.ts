import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const captureApiRouteError = vi.hoisted(() => vi.fn());
vi.mock("./sentry/capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sentry/capture")>();
  return { ...actual, captureApiRouteError };
});
import { apiError, selectedApiError } from "./api-response";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";

beforeEach(() => {
  captureApiRouteError.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("returns safe 503 and exact retry metadata for upstream quota failure", async () => {
  const errorLog = vi.spyOn(console, "error");
  const response = selectedApiError(new JupiterHttpError(429, "/swap/v2/build", 3_001, "api-key=private"), "failed");
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("4");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "Jupiter rate limit reached. Please retry later.",
    code: "jupiter_rate_limited", retryAfterMs: 3_001 });
  expect(errorLog).not.toHaveBeenCalled();
});

it("does not fabricate retry timing when headers are missing", async () => {
  const response = selectedApiError(new JupiterHttpError(503, "/swap/v2/build"), "failed");
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBeNull();
  expect(await response.json()).toMatchObject({ code: "jupiter_unavailable" });
});

it("keeps validation and genuine no-route failures at 400", async () => {
  const response = selectedApiError(new Error("Insufficient input asset balance"), "failed");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Insufficient input asset balance" });
});

it("captures Jupiter and 5xx API failures, not validation 4xx", async () => {
  const jupiter = new JupiterHttpError(503, "/swap/v2/build");
  selectedApiError(jupiter, "failed");
  expect(captureApiRouteError).toHaveBeenCalledWith(jupiter, { fallback: "failed", status: 503 });

  captureApiRouteError.mockClear();
  selectedApiError(new Error("Insufficient input asset balance"), "failed");
  expect(captureApiRouteError).not.toHaveBeenCalled();

  const request = new Request("https://sofinancelab.xyz/api/wallet?wallet=abc");
  const generic = new Error("Wallet scan failed");
  apiError(generic, "Wallet scan failed", 503, { request });
  expect(captureApiRouteError).toHaveBeenCalledWith(generic, {
    fallback: "Wallet scan failed",
    route: undefined,
    request,
    status: 503,
  });

  captureApiRouteError.mockClear();
  apiError(new Error("Invalid wallet address"), "Invalid wallet address");
  expect(captureApiRouteError).not.toHaveBeenCalled();
});
