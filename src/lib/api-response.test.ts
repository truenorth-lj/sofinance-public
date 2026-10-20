import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const captureApiRouteError = vi.hoisted(() => vi.fn());
vi.mock("./sentry/capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sentry/capture")>();
  return { ...actual, captureApiRouteError };
});
import { apiError, selectedApiError } from "./api-response";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import { JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import { SelectedNoRouteError } from "./selected-no-route";
import { AmountTooSmallError } from "./selected-amount-error";

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

it("returns a coded user-facing body for add-liquidity no-route", async () => {
  const response = selectedApiError(new SelectedNoRouteError("SPCX", "INTC", "spcx", "intc"), "Quote failed");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "No route from SPCX to INTC within the transaction size limit. Try USDC, SOL, or one of the pool's tokens.",
    code: "jupiter_no_route",
    inputMint: "spcx",
    outputMint: "intc",
  });
});

it("does not leak Jupiter HTTP 400 when quoteRoute mapped to no-route", async () => {
  const response = selectedApiError(new JupiterNoRouteError(), "Quote failed");
  expect(response.status).toBe(400);
  const body = await response.json() as { error: string; code?: string };
  expect(body.code).toBe("jupiter_no_route");
  expect(body.error).not.toMatch(/HTTP 400/);
  expect(body.error).toMatch(/transaction size limit/);
});

it("returns a coded amount-too-small body for dust Jupiter 400s", async () => {
  const response = selectedApiError(new AmountTooSmallError(), "Quote failed");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Amount too small to swap into this position — try a larger amount",
    code: "amount_too_small",
  });
});

it("returns Jupiter's 400 body instead of bare HTTP 400", async () => {
  const response = selectedApiError(
    new JupiterHttpError(400, "/swap/v1/quote", null, "Token not tradable"), "Quote failed");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Token not tradable",
    code: "jupiter_client_error",
  });
});

it("captures Jupiter 429/5xx and generic 5xx, not user-facing selected 4xx", async () => {
  const rateLimited = new JupiterHttpError(429, "/swap/v2/build", 3_001);
  selectedApiError(rateLimited, "failed");
  expect(captureApiRouteError).toHaveBeenCalledWith(rateLimited, { fallback: "failed", status: 503 });

  captureApiRouteError.mockClear();
  const unavailable = new JupiterHttpError(503, "/swap/v2/build");
  selectedApiError(unavailable, "failed");
  expect(captureApiRouteError).toHaveBeenCalledWith(unavailable, { fallback: "failed", status: 503 });

  captureApiRouteError.mockClear();
  selectedApiError(new SelectedNoRouteError("SPCX", "INTC", "spcx", "intc"), "Quote failed");
  expect(captureApiRouteError).not.toHaveBeenCalled();

  selectedApiError(new JupiterNoRouteError(), "Quote failed");
  expect(captureApiRouteError).not.toHaveBeenCalled();

  selectedApiError(new AmountTooSmallError(), "Quote failed");
  expect(captureApiRouteError).not.toHaveBeenCalled();

  selectedApiError(new JupiterHttpError(400, "/swap/v1/quote", null, "Token not tradable"), "Quote failed");
  expect(captureApiRouteError).not.toHaveBeenCalled();

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
