import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/orca-pairs", () => ({ discoverOrcaPairs: vi.fn(async () => ({ protocol: "orca-whirlpool", readOnly: true, pairs: [{ poolAddress: "pool" }] })) }));
import { discoverOrcaPairs } from "@/lib/orca-pairs";
import { GET } from "./route";

const get = (query = "") => GET(new Request(`https://example.test/api/protocol-pools${query}`));

describe("/api/protocol-pools", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

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
    expect((await get("?protocol=meteora-dlmm")).status).toBe(404);
    expect((await get("?protocol=raydium-clmm")).status).toBe(404);
    expect(discoverOrcaPairs).not.toHaveBeenCalled();
  });
});
