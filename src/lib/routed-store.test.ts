import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createRoutedStore, isAllowedGatewayUrl } from "./routed-store";

class TestStoreError extends Error {
  constructor(public readonly code: string) { super(code); }
}

const secret = "test-only-".repeat(8);
function gatewayEnv(url = "https://rwa.example.com") {
  vi.stubEnv("SOFINANCE_RWA_STORE_MODE", "gateway");
  vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", url);
  vi.stubEnv("CRON_SECRET", secret);
  vi.stubEnv("VERCEL", "1");
}

function makeStore(overrides: Partial<Parameters<typeof createRoutedStore>[0]> = {}) {
  return createRoutedStore({
    path: "/v1/test",
    ErrorClass: TestStoreError,
    unavailableCode: "STORE_UNAVAILABLE",
    makePostgres: () => { throw new Error("direct store should not be built"); },
    timeoutMs: 1_000,
    ...overrides,
  });
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("isAllowedGatewayUrl", () => {
  it("allows https and local http off Vercel, and rejects credentials, fragments, and plaintext production URLs", () => {
    expect(isAllowedGatewayUrl(new URL("https://rwa.example.com"), true)).toBe(true);
    expect(isAllowedGatewayUrl(new URL("http://localhost:3000"), false)).toBe(true);
    expect(isAllowedGatewayUrl(new URL("http://127.0.0.1:3000"), false)).toBe(true);
    expect(isAllowedGatewayUrl(new URL("http://localhost:3000"), true)).toBe(false);
    expect(isAllowedGatewayUrl(new URL("http://rwa.example.com"), false)).toBe(false);
    expect(isAllowedGatewayUrl(new URL("https://user:pass@rwa.example.com"), true)).toBe(false);
    expect(isAllowedGatewayUrl(new URL("https://rwa.example.com#frag"), true)).toBe(false);
  });
});

describe("createRoutedStore gateway validation", () => {
  it("rejects an insecure production URL", () => {
    gatewayEnv("http://rwa.example.com");
    expect(() => makeStore()()).toThrow("INVALID_GATEWAY_URL");
  });
  it("rejects local http when running on Vercel", () => {
    gatewayEnv("http://localhost:3000");
    expect(() => makeStore()()).toThrow("INVALID_GATEWAY_URL");
  });
  it("rejects a URL with userinfo or a fragment", () => {
    gatewayEnv("https://user:pass@rwa.example.com");
    expect(() => makeStore()()).toThrow("INVALID_GATEWAY_URL");
    gatewayEnv("https://rwa.example.com/#token");
    expect(() => makeStore()()).toThrow("INVALID_GATEWAY_URL");
  });
  it("fails closed when the secret is missing or shorter than 32 characters", () => {
    gatewayEnv();
    vi.stubEnv("CRON_SECRET", undefined);
    expect(() => makeStore()()).toThrow("STORE_UNAVAILABLE");
    vi.stubEnv("CRON_SECRET", "too-short");
    expect(() => makeStore()()).toThrow("STORE_UNAVAILABLE");
  });
  it("posts to the given path with a bearer token when the URL and secret are valid", async () => {
    gatewayEnv();
    let posted: unknown;
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      posted = url;
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        headers: { Authorization: expect.stringMatching(/^Bearer /) },
      });
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(makeStore()().request({ op: "ping" } as never)).resolves.toEqual({ ok: true });
    expect(String(posted)).toBe("https://rwa.example.com/v1/test");
  });
});
