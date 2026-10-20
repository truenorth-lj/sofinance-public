import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const captureApiRouteError = vi.hoisted(() => vi.fn());
vi.mock("./sentry/capture", () => ({ captureApiRouteError }));
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

it("captures Jupiter and generic API failures with the public fallback", async () => {
  const jupiter = new JupiterHttpError(503, "/swap/v2/build");
  selectedApiError(jupiter, "failed");
  expect(captureApiRouteError).toHaveBeenCalledWith(jupiter, { fallback: "failed" });

  const generic = new Error("Wallet scan failed");
  await apiError(generic, "Wallet scan failed", 503, { route: "/api/wallet" });
  expect(captureApiRouteError).toHaveBeenCalledWith(generic, { fallback: "Wallet scan failed", route: "/api/wallet" });
});
