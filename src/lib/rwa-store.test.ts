import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const upstream = vi.hoisted(() => ({ discovery: vi.fn(), apr: vi.fn() }));
vi.mock("./rwa-pairs", async (load) => ({
  ...(await load<typeof import("./rwa-pairs")>()),
  discoverRwaPairs: upstream.discovery,
}));
vi.mock("./pool-range-apr", async (load) => ({
  ...(await load<typeof import("./pool-range-apr")>()),
  fetchPoolRangeApr: upstream.apr,
}));
import {
  getPoolAprSnapshot,
  getRwaPairs,
  getRwaStore,
  snapshotError,
} from "./rwa-store";
import { RwaStoreError } from "./rwa-store-types";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function config() {
  vi.stubEnv("SOFINANCE_RWA_STORE_MODE", "gateway");
  vi.stubEnv("SOFINANCE_RWA_DB_ENABLED", "true");
  vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", "https://rwa.example.com");
  vi.stubEnv("CRON_SECRET", "test-only-".repeat(8));
}
describe("saved RWA foreground reads", () => {
  it("preserves APR for ordinary pools outside the RWA feed", async () => {
    config();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ code: "POOL_NOT_TRACKED" }, { status: 503 }),
      ),
    );
    upstream.apr.mockResolvedValue({ ordinaryPool: true });
    expect(await getPoolAprSnapshot("6".repeat(32))).toEqual({
      ordinaryPool: true,
    });
    expect(upstream.apr).toHaveBeenCalledWith("6".repeat(32));
  });
  it("reads the gateway only, without upstream discovery or APR calculation", async () => {
    config();
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe("https://rwa.example.com/v1/rwa");
      return Response.json({ stored: true });
    });
    vi.stubGlobal("fetch", fetcher);
    // A gateway without `tokenIcons` (older store build) gets the manual icon list added, nothing else.
    const pairs = await getRwaPairs({ minTvl: 0, maxPages: 10, sortBy: "tvl" });
    expect(pairs).toEqual({ stored: true, tokenIcons: expect.objectContaining({ solana: expect.any(Object), robinhood: expect.any(Object) }) });
    expect(await getPoolAprSnapshot("1".repeat(32))).toEqual({ stored: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://rwa.example.com/v1/rwa",
    );
    expect(upstream.discovery).not.toHaveBeenCalled();
    expect(upstream.apr).not.toHaveBeenCalled();
  });
  it("fails closed when the gateway fails and returns no credential details", async () => {
    config();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("private connection detail");
      }),
    );
    await expect(getPoolAprSnapshot("1".repeat(32))).rejects.toMatchObject({
      code: "RWA_STORE_UNAVAILABLE",
    });
    const response = snapshotError(new Error("private connection detail"));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private");
    expect(upstream.apr).not.toHaveBeenCalled();
  });
  it("rejects plaintext production transport and propagates coverage failures", async () => {
    config();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", "http://rwa.example.com");
    expect(() => getRwaStore()).toThrow(RwaStoreError);
    vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", "https://rwa.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "SNAPSHOT_COVERAGE_UNAVAILABLE" },
          { status: 503 },
        ),
      ),
    );
    await expect(
      getRwaPairs({ minTvl: 0, maxPages: 30, sortBy: "tvl" }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_COVERAGE_UNAVAILABLE" });
  });
});
