import { describe, expect, it, vi } from "vitest";
import {
  parseRwaRefreshUrl, RWA_REFRESH_CRON_TIMEOUT_MS, RWA_REFRESH_DISABLED_ERROR, runRwaRefreshCron, triggerRwaRefresh,
} from "./rwa-refresh-trigger";

const SECRET = "test-only-cron-secret-at-least-32-characters";
const URL_HTTPS = "https://sofinance-web.up.railway.app/api/internal/rwa-refresh";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("parseRwaRefreshUrl", () => {
  it("accepts HTTPS, and Railway private HTTP only when allowed", () => {
    expect(parseRwaRefreshUrl(URL_HTTPS, { allowRailwayPrivateHttp: false }).host).toBe("sofinance-web.up.railway.app");
    const privateUrl = "http://sofinance-web.railway.internal:8080/api/internal/rwa-refresh";
    expect(parseRwaRefreshUrl(privateUrl, { allowRailwayPrivateHttp: true }).port).toBe("8080");
    expect(() => parseRwaRefreshUrl(privateUrl, { allowRailwayPrivateHttp: false })).toThrow("HTTPS");
  });

  it("rejects missing URLs, other plain HTTP and embedded credentials", () => {
    expect(() => parseRwaRefreshUrl(undefined, { allowRailwayPrivateHttp: true })).toThrow("not configured");
    expect(() => parseRwaRefreshUrl("  ", { allowRailwayPrivateHttp: true })).toThrow("not configured");
    expect(() => parseRwaRefreshUrl("http://example.com/x", { allowRailwayPrivateHttp: true })).toThrow("HTTPS");
    expect(() => parseRwaRefreshUrl("http://evil.railway.internal.example.com/x", { allowRailwayPrivateHttp: true })).toThrow("HTTPS");
    expect(() => parseRwaRefreshUrl("https://u:p@example.com/x", { allowRailwayPrivateHttp: true })).toThrow("credentials");
  });
});

describe("triggerRwaRefresh", () => {
  const url = new URL(URL_HTTPS);

  it("sends GET with only the bearer header, like Vercel's cron", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await triggerRwaRefresh({ url, secret: SECRET, method: "GET", timeoutMs: 1000, fetchImpl });
    const [target, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(target).toBe(url);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
    expect(init.body).toBeUndefined();
  });

  it("sends POST {} as JSON for the data-service scheduler", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await triggerRwaRefresh({ url, secret: SECRET, method: "POST", timeoutMs: 1000, fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init).toMatchObject({ method: "POST", body: "{}", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" } });
  });

  it("classifies ran / disabled / failed", async () => {
    const run = (response: Response | Error) => triggerRwaRefresh({
      url, secret: SECRET, method: "GET", timeoutMs: 1000,
      fetchImpl: async () => { if (response instanceof Error) throw response; return response; },
    });
    expect(await run(json(200, {}))).toEqual({ kind: "ran", status: 200 });
    expect(await run(json(503, { error: RWA_REFRESH_DISABLED_ERROR }))).toEqual({ kind: "disabled", status: 503 });
    expect(await run(json(503, { error: "RWA refresh temporarily unavailable" }))).toEqual({ kind: "failed", status: 503 });
    expect(await run(new Response("not json", { status: 503 }))).toEqual({ kind: "failed", status: 503 });
    expect(await run(json(401, { error: "Unauthorized" }))).toEqual({ kind: "failed", status: 401 });
    expect(await run(new Error("network down"))).toEqual({ kind: "failed", status: null });
  });
});

describe("runRwaRefreshCron", () => {
  const env = { CRON_SECRET: SECRET, SOFINANCE_RWA_REFRESH_URL: URL_HTTPS };

  it("exits 0 when the refresh ran or the target is the standby, 1 when it failed", async () => {
    const lines: string[] = [];
    const code = (response: Response) => runRwaRefreshCron({ env, fetchImpl: async () => response, log: (l) => lines.push(l) });
    expect(await code(json(200, {}))).toBe(0);
    expect(await code(json(503, { error: RWA_REFRESH_DISABLED_ERROR }))).toBe(0);
    expect(await code(json(500, {}))).toBe(1);
    expect(lines[0]).toBe('rwa-refresh-cron {"host":"sofinance-web.up.railway.app","outcome":"ran","status":200}');
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("uses GET with a timeout longer than the route's own 300 s budget", async () => {
    expect(RWA_REFRESH_CRON_TIMEOUT_MS).toBeGreaterThan(300_000);
    const fetchImpl = vi.fn(async () => json(200, {}));
    await runRwaRefreshCron({ env, fetchImpl, log: () => {} });
    expect((fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].method).toBe("GET");
  });

  it("fails fast on missing or weak configuration without calling anything", async () => {
    const fetchImpl = vi.fn();
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    expect(await runRwaRefreshCron({ env: { CRON_SECRET: SECRET }, fetchImpl, log })).toBe(1);
    expect(await runRwaRefreshCron({ env: { ...env, CRON_SECRET: "tiny-secret-value" }, fetchImpl, log })).toBe(1);
    expect(await runRwaRefreshCron({ env: { ...env, SOFINANCE_RWA_REFRESH_URL: "http://example.com/x" }, fetchImpl, log })).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("tiny-secret-value");
  });
});
