import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readProtocolPools, readProtocolRangeApr, protocolPoolReadPolicyFor, dexRegistry } from "./index";
import { GET as poolsGet } from "@/app/api/protocol-pools/route";
import { GET as aprGet } from "@/app/api/protocol-pools/range-apr/route";
import { RwaStoreError } from "@/lib/rwa-store-types";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ orca: vi.fn(), meteora: vi.fn(), rhc: vi.fn(), rhcPools: vi.fn(), liveRhc: vi.fn(), stored: { enabled: true } }));
vi.mock("@/lib/orca-range-apr", async original => ({
  ...await original<typeof import("@/lib/orca-range-apr")>(), fetchOrcaRangeApr: backend.orca,
}));
vi.mock("@/lib/meteora-range-apr", async original => ({
  ...await original<typeof import("@/lib/meteora-range-apr")>(), fetchMeteoraRangeApr: backend.meteora,
}));
vi.mock("@/lib/rhc-snapshot", () => ({ getRhcAprSnapshot: backend.rhc, getRhcPoolsSnapshot: backend.rhcPools }));
vi.mock("@/lib/rhc-range-apr", async original => ({
  ...await original<typeof import("@/lib/rhc-range-apr")>(), fetchRhcRangeApr: backend.liveRhc,
}));
vi.mock("@/lib/config/rwa-env", async original => ({
  ...await original<typeof import("@/lib/config/rwa-env")>(), getRwaConfig: () => ({ enabled: backend.stored.enabled }),
}));
const ORCA = "4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72";
const METEORA = "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H";
const RHC = "0x4f54c74021e4139bbc4c7bc924346c921975136ea120cf118a93c43b50bdbd3c";
const apr = (id: string, poolId: string) => aprGet(new Request(`https://example.test/api/protocol-pools/range-apr?protocol=${id}&poolId=${poolId}`));
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("VERCEL_ENV", "preview"); backend.stored.enabled = true; vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("passes through each protocol payload and preserves healthy/degraded CDN lifetimes", async () => {
  for (const [id, poolId, read] of [["orca-whirlpool", ORCA, backend.orca], ["meteora-dlmm", METEORA, backend.meteora], ["uniswap-v4-rhc", RHC, backend.rhc]] as const) {
    for (const degraded of [false, true]) {
      const payload = { poolId, sample: { degraded }, presets: [], snapshot: { stale: degraded } };
      read.mockResolvedValueOnce(payload);
      const response = await apr(id, poolId);
      expect(response.status).toBe(200); expect(await response.json()).toEqual(payload);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
      expect(response.headers.get("CDN-Cache-Control")).toBe(degraded ? "public, s-maxage=10" : "public, s-maxage=30, stale-while-revalidate=300");
      expect(response.headers.get("Vercel-CDN-Cache-Control")).toBeNull();
      expect(read).toHaveBeenLastCalledWith(poolId);
    }
  }
  expect(backend.liveRhc).not.toHaveBeenCalled();
});

it("retains RHC snapshot error codes with no live-read fallback, and protocol error policy separately", async () => {
  backend.rhc.mockRejectedValueOnce(new RwaStoreError("SNAPSHOT_UNAVAILABLE"));
  const response = await apr("uniswap-v4-rhc", RHC);
  expect(response.status).toBe(503); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("CDN-Cache-Control")).toBeNull();
  expect(response.headers.get("Vercel-CDN-Cache-Control")).toBeNull();
  expect(await response.json()).toMatchObject({ code: "SNAPSHOT_UNAVAILABLE" });
  expect(backend.liveRhc).not.toHaveBeenCalled();
  backend.rhcPools.mockRejectedValueOnce(new RwaStoreError("SNAPSHOT_UNAVAILABLE"));
  const discovery = await poolsGet(new Request("https://example.test/api/protocol-pools?protocol=uniswap-v4-rhc"));
  expect(discovery.status).toBe(503); expect(await discovery.json()).toMatchObject({ code: "SNAPSHOT_UNAVAILABLE" });
  backend.stored.enabled = false; backend.rhc.mockRejectedValueOnce(new Error("upstream failure"));
  expect((await apr("uniswap-v4-rhc", RHC)).status).toBe(503);
  expect(protocolPoolReadPolicyFor("uniswap-v4-rhc")).toEqual({ snapshotBacked: true, rangeAprUnavailableMessage: "RHC range APR unavailable" });
  expect(protocolPoolReadPolicyFor("orca-whirlpool")?.snapshotBacked).toBe(false);
});

it("returns null for off/unknown/prototype ids and refuses cross-protocol pools before an upstream read", async () => {
  for (const id of ["raydium-clmm", "rhc-uniswap-v4", "unknown", "__proto__", "constructor"]) {
    expect(await readProtocolPools(id)).toBeNull(); expect(await readProtocolRangeApr(id, ORCA)).toBeNull();
    expect(protocolPoolReadPolicyFor(id)).toBeNull();
  }
  expect(await readProtocolRangeApr("orca-whirlpool", METEORA)).toBeNull();
  expect(await readProtocolRangeApr("meteora-dlmm", ORCA)).toBeNull();
  expect(await readProtocolRangeApr("uniswap-v4-rhc", ORCA)).toBeNull();
  vi.stubEnv("VERCEL_ENV", "production");
  for (const id of ["orca-whirlpool", "meteora-dlmm"]) {
    expect(await readProtocolPools(id)).toBeNull(); expect(await readProtocolRangeApr(id, ORCA)).toBeNull();
  }
  expect(backend.orca).not.toHaveBeenCalled(); expect(backend.meteora).not.toHaveBeenCalled(); expect(backend.rhc).not.toHaveBeenCalled();
  expect(dexRegistry.isDisabled("orca-whirlpool", "positions")).toBe(true);
  expect(dexRegistry.isDisabled("uniswap-v4-rhc", "open")).toBe(true);
});
