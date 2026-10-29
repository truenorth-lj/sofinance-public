import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "./route";

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";
const request = () => new Request(`http://localhost/api/pool-activity?poolId=${POOL}`);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/pool-activity", () => {
  it.each([undefined, "production"])("is disabled without contacting Solami when VERCEL_ENV=%s", async (vercelEnv) => {
    vi.stubEnv("VERCEL_ENV", vercelEnv);
    vi.stubEnv("SOLAMI_DATA_API_KEY", "test-data-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false, poolId: POOL, source: "unavailable", reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on preview, reports a plan refusal as a sanitized reason", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("SOLAMI_DATA_API_KEY", "test-data-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(request());
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ available: false, reason: "plan-401" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(text).not.toMatch(/test-data-key|solami\.dev/);
  });

  it("on preview without a key, reports not-configured", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("SOLAMI_DATA_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await (await GET(request())).json()).toMatchObject({ available: false, reason: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
