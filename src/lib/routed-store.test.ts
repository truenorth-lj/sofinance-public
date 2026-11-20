import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
  it("maps a schema parse failure to the store unavailable code", async () => {
    gatewayEnv();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    const getStore = makeStore({ schema: z.object({ op: z.literal("ping") }) });
    await expect(getStore().request({ op: "other" } as never)).rejects.toThrow("STORE_UNAVAILABLE");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps abort, timeout, and invalid JSON distinct from an unavailable store", async () => {
    gatewayEnv();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const password = "super-secret-db-password";
    const databaseUrl = `postgres://sofinance_owner:${password}@ep-private.neon.tech/sofinance`;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }));
    await expect(makeStore()().request({ op: "ping" } as never)).rejects.toThrow("GATEWAY_TIMEOUT");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted", "AbortError"); }));
    await expect(makeStore()().request({ op: "ping" } as never)).rejects.toThrow("GATEWAY_TIMEOUT");
    const caused = new TypeError("fetch failed");
    caused.cause = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw caused; }));
    await expect(makeStore()().request({ op: "ping" } as never)).rejects.toThrow("GATEWAY_TIMEOUT");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`not json ${databaseUrl}`, { status: 502 })));
    await expect(makeStore()().request({ op: "ping" } as never)).rejects.toThrow("GATEWAY_PARSE");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "LEASE_LOST" }, { status: 409 })));
    await expect(makeStore()().request({ op: "ping" } as never)).rejects.toThrow("LEASE_LOST");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: databaseUrl }, { status: 503 })));
    await expect(makeStore()().request({ op: "ping" } as never)).rejects.toThrow("STORE_UNAVAILABLE");
    const postgres = Object.assign(new Error(`connect failed ${databaseUrl} DATABASE_URL=${databaseUrl}`), { code: "08006" });
    postgres.name = "PostgresError";
    vi.stubGlobal("fetch", vi.fn(async () => { throw postgres; }));
    const thrown = await makeStore()().request({ op: "ping" } as never).then(() => undefined, (error: unknown) => error) as Error & { pgCode?: string };
    expect(thrown.message).toBe("STORE_UNAVAILABLE");
    expect(thrown.name).toBe("PostgresError");
    expect(thrown.pgCode).toBe("08006");
    const payload = JSON.stringify(logged.mock.calls);
    expect(payload).toContain("TimeoutError");
    expect(payload).toContain("AbortError");
    expect(payload).toContain("GATEWAY_TIMEOUT");
    expect(payload).toContain("GATEWAY_PARSE");
    expect(payload).toContain("SyntaxError");
    expect(payload).toContain("LEASE_LOST");
    expect(payload).toContain("08006");
    expect(payload).toContain("PostgresError");
    expect(payload).not.toContain(password);
    expect(payload).not.toContain("postgres://");
    expect(payload).not.toContain("DATABASE_URL");
    expect(payload).not.toContain("neon.tech");
    logged.mockRestore();
  });
});
