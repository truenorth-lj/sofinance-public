import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/protocol-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/protocol-flags")>();
  return { ...actual, isRhcUniv4DiscoveryEnabled: vi.fn(actual.isRhcUniv4DiscoveryEnabled) };
});
vi.mock("@/lib/orca-pairs", () => ({ discoverOrcaPairs: vi.fn(async () => ({ protocol: "orca-whirlpool", readOnly: true, pairs: [{ poolAddress: "pool" }] })) }));
vi.mock("@/lib/meteora-pairs", () => ({ discoverMeteoraPairs: vi.fn(async () => ({ protocol: "meteora-dlmm", readOnly: true, pairs: [{ poolAddress: "dlmm" }] })) }));
vi.mock("@/lib/rhc-univ4-pools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rhc-univ4-pools")>()),
  discoverRhcUniv4Pools: vi.fn(async () => ({ protocol: "uniswap-v4-rhc", chainId: 4663, readOnly: true, pools: [{ poolId: "0xpool", status: "listed" }] })),
}));
const store = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/rwa-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rwa-store")>()), getRwaStore: () => store,
}));
vi.mock("@/lib/config/rwa-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/rwa-env")>();
  return { ...actual, getRwaConfig: vi.fn(actual.getRwaConfig) };
});
import { getRwaConfig } from "@/lib/config/rwa-env";
import { RwaStoreError } from "@/lib/rwa-store-types";
import { discoverMeteoraPairs } from "@/lib/meteora-pairs";
import { discoverOrcaPairs } from "@/lib/orca-pairs";
import { discoverRhcUniv4Pools } from "@/lib/rhc-univ4-pools";
import { isRhcUniv4DiscoveryEnabled } from "@/lib/protocol-flags";
import { GET } from "./route";

const get = (query = "") => GET(new Request(`https://example.test/api/protocol-pools${query}`));

describe("/api/protocol-pools", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.mocked(getRwaConfig).mockReset(); });

  it.each([undefined, "production"])("404s and never calls Orca when VERCEL_ENV=%s (flag off)", async (env) => {
    vi.stubEnv("VERCEL_ENV", env);
    const response = await get("?protocol=orca-whirlpool");
    expect(response.status).toBe(404);
    expect(discoverOrcaPairs).not.toHaveBeenCalled();
  });

  it("serves read-only Orca rows on preview", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ protocol: "orca-whirlpool", readOnly: true, pairs: [{ poolAddress: "pool" }] });
  });

  it("404s for unknown protocols even on preview", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await get("?protocol=raydium-clmm")).status).toBe(404);
    expect((await get("?protocol=meteora")).status).toBe(404);
    expect(discoverOrcaPairs).not.toHaveBeenCalled();
  });

  it("404s and never touches Robinhood Chain when the flag is off (kill switch)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.mocked(isRhcUniv4DiscoveryEnabled).mockReturnValueOnce(false);
    const response = await get("?protocol=uniswap-v4-rhc");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(discoverRhcUniv4Pools).not.toHaveBeenCalled();
  });

  it("serves read-only Robinhood Chain Uniswap v4 pools on preview with CDN caching", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    // No RWA store configured (local dev): the live read is the fallback.
    vi.mocked(getRwaConfig).mockReturnValue({ ...vi.mocked(getRwaConfig).getMockImplementation()!(), enabled: false });
    const response = await get("?protocol=uniswap-v4-rhc");
    expect(response.status).toBe(200);
    expect(response.headers.get("CDN-Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(await response.json()).toMatchObject({ protocol: "uniswap-v4-rhc", chainId: 4663, readOnly: true, pools: [{ status: "listed" }] });
    expect(discoverOrcaPairs).not.toHaveBeenCalled();
  });

  it("with the RWA store on, serves the cron's saved RHC pools and never calls RPC or indexers", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.mocked(getRwaConfig).mockReturnValue({ ...vi.mocked(getRwaConfig).getMockImplementation()!(), enabled: true });
    store.request.mockResolvedValueOnce({ pools: [{ poolId: "0xsaved", status: "listed" }], observedAt: "2026-10-30T00:15:00.000Z", stale: false });
    const response = await get("?protocol=uniswap-v4-rhc");
    expect(response.status).toBe(200);
    expect(store.request).toHaveBeenCalledWith({ op: "rhcPools" });
    expect(discoverRhcUniv4Pools).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ protocol: "uniswap-v4-rhc", fetchedAt: "2026-10-30T00:15:00.000Z",
      snapshot: { stale: false }, pools: [{ poolId: "0xsaved" }] });

    store.request.mockRejectedValueOnce(new RwaStoreError("SNAPSHOT_UNAVAILABLE"));
    const missing = await get("?protocol=uniswap-v4-rhc");
    expect(missing.status).toBe(503);
    expect(discoverRhcUniv4Pools).not.toHaveBeenCalled();
  });

  it.each([undefined, "production"])("404s and never calls Meteora when VERCEL_ENV=%s (flag off)", async (env) => {
    vi.stubEnv("VERCEL_ENV", env);
    const response = await get("?protocol=meteora-dlmm");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(discoverMeteoraPairs).not.toHaveBeenCalled();
  });

  it("serves read-only Meteora DLMM rows on preview", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const response = await get("?protocol=meteora-dlmm");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ protocol: "meteora-dlmm", readOnly: true, pairs: [{ poolAddress: "dlmm" }] });
    expect(discoverOrcaPairs).not.toHaveBeenCalled();
    expect(discoverRhcUniv4Pools).not.toHaveBeenCalled();
  });

  it("does not resolve prototype keys as protocols", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    for (const key of ["toString", "__proto__", "constructor", "hasOwnProperty"]) expect((await get(`?protocol=${key}`)).status).toBe(404);
  });
});
