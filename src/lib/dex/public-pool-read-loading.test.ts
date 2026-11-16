import { expect, it, vi } from "vitest";
import { readProtocolPools, readProtocolRangeApr, protocolPoolReadPolicyFor } from "./index";
vi.mock("server-only", () => ({}));
const loaded = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/orca-pairs", () => { loaded.push("orca-discovery"); return { discoverOrcaPairs: () => ({ pairs: [] }) }; });
vi.mock("@/lib/meteora-pairs", () => { loaded.push("meteora-discovery"); return { discoverMeteoraPairs: () => ({ pairs: [] }) }; });
vi.mock("@/lib/orca-range-apr", () => { loaded.push("orca-apr"); return { isAllowlistedOrcaPool: () => false }; });
vi.mock("@/lib/meteora-range-apr", () => { loaded.push("meteora-apr"); return { isAllowlistedMeteoraPool: () => false }; });
it("loads no readers for metadata or disabled requests and isolates discovery from APR and other protocols", async () => {
  vi.stubEnv("VERCEL_ENV", "production");
  try {
    expect(protocolPoolReadPolicyFor("orca-whirlpool")?.snapshotBacked).toBe(false);
    for (const id of ["orca-whirlpool", "meteora-dlmm"]) {
      expect(await readProtocolPools(id)).toBeNull(); expect(await readProtocolRangeApr(id, "bad")).toBeNull();
    }
    expect(loaded).toEqual([]);
    vi.stubEnv("VERCEL_ENV", "preview");
    await readProtocolPools("orca-whirlpool"); expect(loaded).toEqual(["orca-discovery"]);
    await readProtocolRangeApr("meteora-dlmm", "bad"); expect(loaded).toEqual(["orca-discovery", "meteora-apr"]);
  } finally { vi.unstubAllEnvs(); }
});
