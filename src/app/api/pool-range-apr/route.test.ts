import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fetchPoolRangeApr = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pool-range-apr", () => ({ fetchPoolRangeApr }));

import { GET } from "./route";

const POOL = "5MBpNcWTqiWy3pZX17pYfgP2ZxrSkok4naQWLj3XLDLY";
const call = (query: string) => GET(new Request(`http://localhost/api/pool-range-apr${query}`));

afterEach(() => {
  fetchPoolRangeApr.mockReset();
  vi.spyOn(console, "error").mockRestore();
});

describe("GET /api/pool-range-apr", () => {
  it("returns the payload with short CDN caching", async () => {
    const payload = { poolId: POOL, label: "Est. fee APR", presets: [], sample: { degraded: false } };
    fetchPoolRangeApr.mockResolvedValue(payload);
    const response = await call(`?poolId=${POOL}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(fetchPoolRangeApr).toHaveBeenCalledWith(POOL);
    expect(response.headers.get("CDN-Cache-Control")).toMatch(/s-maxage=30/);
    expect(response.headers.get("Cache-Control")).not.toMatch(/no-store/);
  });

  it("does not pin a degraded payload (no estimates) at the CDN: 10 s, no stale-while-revalidate", async () => {
    fetchPoolRangeApr.mockResolvedValue({ poolId: POOL, presets: [], sample: { degraded: true } });
    const response = await call(`?poolId=${POOL}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("CDN-Cache-Control")).toBe("public, s-maxage=10");
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("public, s-maxage=10");
    expect(response.headers.get("CDN-Cache-Control")).not.toMatch(/stale-while-revalidate/);
  });

  it("rejects a missing or malformed pool id without touching upstreams", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const query of ["", "?poolId=", "?poolId=not%20base58", "?poolId=0OIl", `?poolId=${POOL}${POOL}`]) {
      const response = await call(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    }
    expect(fetchPoolRangeApr).not.toHaveBeenCalled();
  });

  it("answers 503 with a public error and no-store when upstreams fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchPoolRangeApr.mockRejectedValue(new Error("Pool economics unavailable from Raydium"));
    const response = await call(`?poolId=${POOL}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: expect.stringMatching(/unavailable/i) });
  });
});
