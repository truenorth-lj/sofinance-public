import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/orca-range-apr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orca-range-apr")>()),
  fetchOrcaRangeApr: vi.fn(async (poolId: string) => ({ poolId, protocol: "orca-whirlpool", readOnly: true, sample: { degraded: false }, presets: [] })),
}));
import { fetchOrcaRangeApr } from "@/lib/orca-range-apr";
import { GET } from "./route";

const POOL = "4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72";
const get = (query: string) => GET(new Request(`https://example.test/api/protocol-pools/range-apr${query}`));

describe("/api/protocol-pools/range-apr", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it.each([undefined, "production"])("404s and never reads Orca when VERCEL_ENV=%s (flag off)", async (env) => {
    vi.stubEnv("VERCEL_ENV", env);
    const response = await get(`?protocol=orca-whirlpool&poolId=${POOL}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchOrcaRangeApr).not.toHaveBeenCalled();
  });

  it("serves the read-only Orca payload on preview", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const response = await get(`?poolId=${POOL}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ poolId: POOL, protocol: "orca-whirlpool", readOnly: true });
    expect(response.headers.get("cdn-cache-control")).toMatch(/s-maxage=30/);
  });

  it("404s for other protocols, non-allowlisted or missing pools even on preview", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    for (const query of [`?protocol=raydium-clmm&poolId=${POOL}`, "?poolId=ERVsqZ1QAdQhoShqPhB2dFGu2CWQAa1tWzpQbi64ku9K", "", "?poolId=not-a-key"]) {
      expect((await get(query)).status, query).toBe(404);
    }
    expect(fetchOrcaRangeApr).not.toHaveBeenCalled();
  });

  it("503s when upstream data is unavailable", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.mocked(fetchOrcaRangeApr).mockRejectedValueOnce(new Error("boom"));
    expect((await get(`?poolId=${POOL}`)).status).toBe(503);
  });
});
