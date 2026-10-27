import { inspect } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const captureApiRouteError = vi.hoisted(() => vi.fn());
vi.mock("./sentry/capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sentry/capture")>();
  return { ...actual, captureApiRouteError };
});
import { apiError, selectedApiError } from "./api-response";
import { JupiterRelayMissingError } from "@sofinance/engine/jupiter/client";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import { JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import { SelectedNoRouteError } from "./selected-no-route";
import { AmountTooSmallError } from "./selected-amount-error";
import { CompoundSendError } from "./public-error";

beforeEach(() => {
  captureApiRouteError.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const reviewSecret = "REVIEW_SYNTHETIC_ONLY_20261027";
it.each([
  `Authorization: Bearer ${reviewSecret}`,
  `Authorization: Basic ${reviewSecret}+TAIL==`,
  JSON.stringify({ "api-key": reviewSecret }),
  JSON.stringify({ authorization: `Bearer ${reviewSecret}` }),
  encodeURIComponent(`https://rpc.invalid/?api-key=${reviewSecret}`),
])("redacts B1 text in API logs and responses: %s", async (credential) => {
  const nested = new TypeError(`nested diagnostic ${credential}`);
  nested.stack = `TypeError: ${credential}\n    at fetchRpc (/app/rpc.ts:12:3)`;
  const cause = Object.assign(new Error(`provider failed ${credential}`, { cause: nested }), { code: "E_UPSTREAM" });
  cause.stack = `Error: ${credential}\n    at quote (/app/quote.ts:24:5)`;
  // Exercise both the ordinary message and CompoundSendError's public cause path.
  for (const error of [cause, new CompoundSendError(cause, false)]) {
    const response = apiError(error, `Quote failed ${credential}`);
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("provider failed");
    expect(body.error.length).toBeLessThanOrEqual(220);
    expect(body.sent).toBe(error instanceof CompoundSendError ? false : undefined);
    expect(JSON.stringify(body)).not.toContain(reviewSecret);
    expect(JSON.stringify(body)).not.toContain("TAIL");
    expect(JSON.stringify(body)).not.toContain("rpc.invalid");
  }
  const calls = vi.spyOn(console, "error").mock.calls;
  const logged = inspect(calls, { depth: null, customInspect: false });
  expect(calls).toHaveLength(2);
  expect(logged).not.toContain(reviewSecret);
  expect(logged).not.toContain("TAIL");
  expect(logged).not.toContain("rpc.invalid");
  expect(logged).toContain("E_UPSTREAM");
  expect(logged).toContain("nested diagnostic");
  expect(logged).toContain("/app/rpc.ts:12:3");
  expect(logged).toContain("/app/quote.ts:24:5");
});

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

it("rethrows the expected Jupiter relay miss so the 409 is not console.error'd", () => {
  const errorLog = vi.spyOn(console, "error");
  const missing = new JupiterRelayMissingError({ method: "GET", url: "/swap/v1/quote?amount=1" });
  expect(() => apiError(missing, "Open-position quote failed")).toThrow(missing);
  expect(errorLog).not.toHaveBeenCalled();
});

it("redacts provider keys in console messages, stacks, and nested causes", async () => {
  const secret = "AUDIT_SYNTHETIC_NOT_A_REAL_SECRET";
  const url = `https://rpc.invalid/?api-key=${secret}`;
  const cause = new TypeError(`fetch failed ${url}`, {
    cause: { endpoint: url, headers: { authorization: `Bearer ${secret}` } },
  });
  cause.stack = `TypeError: fetch failed ${url}\n    at fetchRpc (/app/rpc.ts:12:3)`;
  const error = new Error(`provider failed ${url}`, { cause });
  error.stack = `Error: provider failed ${url}\n    at quote (/app/quote.ts:24:5)`;

  const response = apiError(error, `Quote failed ${url}`);
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).not.toContain(secret);
  const calls = vi.spyOn(console, "error").mock.calls;
  // Inspect the actual console arguments too: JSON.stringify(Error) omits its
  // non-enumerable message/stack and would miss the original leak.
  const logged = inspect(calls, { depth: null, customInspect: false });
  expect(logged).not.toContain(secret);
  expect(logged).not.toContain("rpc.invalid");
  expect(logged).toContain("provider failed");
  expect(logged).toContain("TypeError");
  expect(logged).toContain("/app/rpc.ts:12:3");
  expect(logged).toContain("/app/quote.ts:24:5");
  expect(calls).toHaveLength(1);
});
