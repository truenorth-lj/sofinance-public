import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const loadProfile = vi.hoisted(() => vi.fn());
vi.mock("./pool-range-apr", async (load) => ({
  ...await load<typeof import("./pool-range-apr")>(), loadVolumeProfile: loadProfile,
}));
import { refreshProfile } from "./rwa-refresh";
import { ALGORITHM_VERSION, type ActivePool } from "./rwa-store-types";
import type { VolumeProfile } from "./pool-range-apr";

const now = Date.parse("2026-10-14T00:15:00Z");
function fixture(): ActivePool {
  const profile = { economics: { mintA: "a", mintB: "b" }, candles: [{ timestamp: 1 }], stale: false,
    daily: null, issues: [], observedAt: { economics: "2026-10-14T00:12:00Z", daily: null, hourly: "2026-10-14T00:11:00Z" } } as unknown as VolumeProfile;
  return { pair: { poolAddress: "pool", mintA: "a", mintB: "b" } as ActivePool["pair"], metricsObservedAt: "2026-10-14T00:12:00Z",
    profile: { algorithmVersion: ALGORITHM_VERSION, profile, observedAt: "2026-10-14T00:11:00Z", windowEndUtc: "2026-10-14T00:00:00.000Z" } };
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe("persistent market profile", () => {
  it("reuses a current cached profile without retimestamping or upstream requests", async () => {
    const pool = fixture();
    expect(await refreshProfile(pool, fetch, now, new AbortController().signal)).toBe(pool.profile);
    expect(loadProfile).not.toHaveBeenCalled();
  });
  it("invalidates the cache after a UTC rollover or algorithm change", async () => {
    const pool = fixture();
    pool.profile!.windowEndUtc = "2026-10-13T00:00:00.000Z";
    loadProfile.mockResolvedValue(pool.profile!.profile);
    const result = await refreshProfile(pool, fetch, now, new AbortController().signal);
    expect(loadProfile).toHaveBeenCalledTimes(1);
    expect(result.windowEndUtc).toBe("2026-10-14T00:00:00.000Z");
    expect(result.observedAt).toBe("2026-10-14T00:11:00Z");
    pool.profile!.algorithmVersion = "old";
    await refreshProfile(pool, fetch, now, new AbortController().signal);
    expect(loadProfile).toHaveBeenCalledTimes(2);
  });
  it("preserves the age and marks fallback candles stale after upstream failure", async () => {
    const pool = fixture();
    pool.profile!.observedAt = "2026-10-13T23:00:00Z";
    loadProfile.mockResolvedValue({ ...pool.profile!.profile, candles: null });
    const result = await refreshProfile(pool, fetch, now, new AbortController().signal);
    expect(result.observedAt).toBe("2026-10-13T23:00:00Z");
    expect(result.profile.stale).toBe(true);
    expect(result.profile.candles).toEqual(pool.profile!.profile.candles);
  });
});
