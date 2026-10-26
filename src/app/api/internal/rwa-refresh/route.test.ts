import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rwa-refresh", () => ({ refreshRwaSnapshots: vi.fn() }));
vi.mock("@/lib/sentry/capture", () => ({ captureApiRouteError: vi.fn() }));
import { refreshRwaSnapshots } from "@/lib/rwa-refresh";
import { captureApiRouteError } from "@/lib/sentry/capture";
import { GET, POST, maxDuration } from "./route";

const secret = "test-only-".repeat(8);
const result = { discovery: { status: "skipped" }, apr: { status: "ok" } };
function request(method: string, body?: string, query = "", auth: string | null = secret) {
  return new Request(`https://app.invalid/api/internal/rwa-refresh${query}`, {
    method, headers: auth ? { Authorization: `Bearer ${auth}` } : {}, ...(body === undefined ? {} : { body }),
  });
}
beforeEach(() => {
  vi.stubEnv("CRON_SECRET", secret);
  vi.stubEnv("SOFINANCE_RWA_REFRESH_ENABLED", "true");
  vi.stubEnv("SOFINANCE_RWA_NATIVE_CRON_ENABLED", "true");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.mocked(refreshRwaSnapshots).mockResolvedValue(result as Awaited<ReturnType<typeof refreshRwaSnapshots>>);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("native cron adapter", () => {
  it("runs a bodyless GET with normal due semantics and no-store", async () => {
    expect(maxDuration).toBe(300);
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(result);
    expect(refreshRwaSnapshots).toHaveBeenCalledWith({ force: false });
  });
  it("ignores query force and repeated ticks still use the normal lease path", async () => {
    await GET(request("GET", undefined, "?force=true"));
    await GET(request("GET", undefined, "?force=1"));
    expect(refreshRwaSnapshots).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(refreshRwaSnapshots).mock.calls) expect(call).toEqual([{ force: false }]);
  });
  it.each([null, "wrong"])("rejects absent/wrong authorization %s", async (auth) => {
    expect((await GET(request("GET", undefined, "", auth))).status).toBe(401);
    expect(refreshRwaSnapshots).not.toHaveBeenCalled();
  });
  it("rejects an unconfigured secret", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    expect((await GET(request("GET"))).status).toBe(401);
  });
  it("disables native GET by default while old timer POST still works", async () => {
    vi.stubEnv("SOFINANCE_RWA_NATIVE_CRON_ENABLED", undefined);
    expect((await GET(request("GET"))).status).toBe(503);
    expect(refreshRwaSnapshots).not.toHaveBeenCalled();
    expect((await POST(request("POST", "{}"))).status).toBe(200);
    expect(refreshRwaSnapshots).toHaveBeenCalledWith({ force: undefined });
  });
  it.each(["preview", "development"])("gates both methods in %s", async (environment) => {
    vi.stubEnv("VERCEL_ENV", environment);
    expect((await GET(request("GET"))).status).toBe(503);
    expect((await POST(request("POST", "{}"))).status).toBe(503);
    expect(refreshRwaSnapshots).not.toHaveBeenCalled();
  });
  it("gates both methods when refresh is disabled", async () => {
    vi.stubEnv("SOFINANCE_RWA_REFRESH_ENABLED", "false");
    expect((await GET(request("GET"))).status).toBe(503);
    expect((await POST(request("POST", "{}"))).status).toBe(503);
    expect(refreshRwaSnapshots).not.toHaveBeenCalled();
  });
  it.each(["", "null", "[]", "{", '{"force":"true"}', '{"extra":1}'])("preserves strict POST JSON for %s", async (body) => {
    expect((await POST(request("POST", body))).status).toBe(400);
    expect(refreshRwaSnapshots).not.toHaveBeenCalled();
  });
  it("preserves authenticated POST force", async () => {
    expect((await POST(request("POST", '{"force":true}'))).status).toBe(200);
    expect(refreshRwaSnapshots).toHaveBeenCalledWith({ force: true });
  });
  it("returns 503 for either failed job", async () => {
    for (const job of ["discovery", "apr"]) {
      vi.mocked(refreshRwaSnapshots).mockResolvedValue({ ...result, [job]: { status: "error" } } as Awaited<ReturnType<typeof refreshRwaSnapshots>>);
      expect((await GET(request("GET"))).status).toBe(503);
    }
  });
  it("sanitizes thrown errors before monitoring and recovers on the next tick", async () => {
    vi.mocked(refreshRwaSnapshots).mockRejectedValueOnce(new Error("private DB credential"));
    const response = await GET(request("GET"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("credential");
    expect(vi.mocked(captureApiRouteError).mock.calls[0]?.[0]).toEqual(new Error("RWA refresh temporarily unavailable"));
    expect((await GET(request("GET"))).status).toBe(200);
  });
});
