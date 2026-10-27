import { inspect } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { logSafeError } from "./safe-error-log";

const secret = "LOG_SYNTHETIC_NOT_A_REAL_SECRET";
const url = `https://rpc.invalid/?api-key=${secret}`;

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

function logged() {
  return inspect(vi.spyOn(console, "error").mock.calls, { depth: null });
}

it.each([
  `Authorization: Bearer ${secret}`,
  `Authorization: Basic ${secret}+TAIL==`,
  JSON.stringify({ "api-key": secret }),
  JSON.stringify({ Authorization: `Basic ${secret}` }),
  encodeURIComponent(url),
])("scrubs B1 credentials in all diagnostic fields: %s", (credential) => {
  const nested = Object.assign(new TypeError(`nested ${credential}`), { code: "E_UPSTREAM" });
  nested.stack = `TypeError: ${credential}\n    at fetchRpc (/app/rpc.ts:12:3)`;
  const error = new Error(`provider failed ${credential}`, { cause: { nested, text: credential } });
  nested.cause = error;
  error.stack = `Error: ${credential}\n    at quote (/app/quote.ts:24:5)`;
  logSafeError(`Request failed ${credential}`, error);
  expect(logged()).not.toContain(secret);
  expect(logged()).not.toContain("TAIL");
  expect(logged()).not.toContain("rpc.invalid");
  expect(logged()).toContain("E_UPSTREAM");
  expect(logged()).toContain("provider failed");
  expect(logged()).toContain("TypeError");
  expect(logged()).toContain("[circular]");
  expect(logged()).toContain("/app/rpc.ts:12:3");
  expect(logged()).toContain("/app/quote.ts:24:5");
  expect(nested.message).toContain(secret);
});

it("preserves error diagnostics and scrubs non-enumerable fields without mutating the original", () => {
  const cause = new TypeError(`fetch failed ${url}`);
  cause.stack = `TypeError: fetch failed ${url}\n    at fetchRpc (/app/rpc.ts:12:3)`;
  const error = Object.assign(new Error(`request failed ${url}`, { cause }), {
    code: "ETIMEDOUT", status: 503,
    headers: { "x-api-key": secret, "content-type": "application/json" },
  });
  error.stack = `Error: request failed ${url}\n    at quote (/app/quote.ts:24:5)`;
  logSafeError(`Quote failed ${url}`, error);
  expect(logged()).not.toContain(secret);
  expect(logged()).not.toContain("rpc.invalid");
  expect(vi.spyOn(console, "error").mock.calls[0]).toEqual([
    "Quote failed [redacted-url]",
    expect.objectContaining({
      name: "Error", message: "request failed [redacted-url]",
      stack: "Error: request failed [redacted-url]\n    at quote (/app/quote.ts:24:5)",
      code: "ETIMEDOUT", status: 503,
      headers: { "x-api-key": "[redacted]", "content-type": "application/json" },
      cause: expect.objectContaining({ name: "TypeError", message: "fetch failed [redacted-url]" }),
    }),
  ]);
  expect(error.message).toContain(secret);
  expect(error.stack).toContain(secret);
  expect(error.cause).toBe(cause);
  expect(error.headers["x-api-key"]).toBe(secret);
});

it("handles AggregateError, cyclic causes, and nested arrays", () => {
  const cause = new Error(`failure ${url}`);
  const error = new AggregateError([cause, { endpoint: encodeURIComponent(url), token: secret }], "all failed");
  cause.cause = error;
  logSafeError("Failed", error);
  expect(logged()).not.toContain(secret);
  expect(logged()).not.toContain("rpc.invalid");
  expect(logged()).toContain("AggregateError");
  expect(logged()).toContain("[circular]");
  expect(logged()).toContain("failure [redacted-url]");
});

it("scrubs strings, encoded URLs and dynamic object keys, and accepts non-error throws", () => {
  for (const value of [url, encodeURIComponent(encodeURIComponent(url)), null, undefined, 7, true, 9n,
    { [url]: url, token: secret }, Symbol(secret)]) logSafeError("Failed", value);
  expect(logged()).not.toContain(secret);
  expect(logged()).not.toContain("rpc.invalid");
  expect(logged()).toContain("[redacted-url]");
});

it("does not invoke getters, toJSON or custom inspect hooks on diagnostic objects", () => {
  const getter = vi.fn(() => { throw new Error(secret); });
  const toJSON = vi.fn(() => secret);
  const customInspect = vi.fn(() => secret);
  const details = Object.defineProperty({ toJSON, [inspect.custom]: customInspect }, "endpoint", {
    enumerable: true, get: getter,
  });
  logSafeError("Failed", new Error("diagnostic unavailable", { cause: details }));
  expect(logged()).not.toContain(secret);
  expect(logged()).toContain("[unavailable]");
  expect(getter).not.toHaveBeenCalled();
  expect(toJSON).not.toHaveBeenCalled();
  expect(customInspect).not.toHaveBeenCalled();
});

it.each(["name", "stack", "cause"])("fails closed for unreadable error %s and revoked proxies", (field) => {
  const error = new Error("still useful");
  Object.defineProperty(error, field, { get: () => { throw new Error(secret); } });
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  expect(() => logSafeError("Failed", error)).not.toThrow();
  expect(() => logSafeError("Failed", proxy)).not.toThrow();
  expect(logged()).not.toContain(secret);
  expect(logged()).toContain("[unavailable]");
  expect(logged()).toContain("still useful");
});

it("retains native lazy Error stacks", () => {
  logSafeError("Failed", new TypeError("useful diagnostic"));
  expect(vi.spyOn(console, "error").mock.calls[0]?.[1]).toMatchObject({
    name: "TypeError", stack: expect.stringContaining("safe-error-log.test.ts"),
  });
});

it("bounds deep cause chains and wide arrays", () => {
  let error = new Error(url);
  for (let i = 0; i < 100; i += 1) error = new Error(`level ${i}`, { cause: error });
  expect(() => logSafeError("Failed", error)).not.toThrow();
  logSafeError("Failed", Array.from({ length: 100 }, () => url));
  expect(logged()).not.toContain(secret);
  expect(logged()).toContain("[truncated]");
});
