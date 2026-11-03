import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({}) }));
vi.mock("./protocol-flags", async (load) => ({ ...await load<typeof import("./protocol-flags")>(), isRhcApr7dEnabled: () => false }));
const fake = vi.hoisted(() => ({ loadProfile: vi.fn(), readLiquidity: vi.fn(), active: 0, peak: 0 }));
vi.mock("./pool-sources/meteora", async (load) => {
  const actual = await load<typeof import("./pool-sources/meteora")>();
  const { payloadFixture } = await import("./range-apr/payload.fixture");
  return { ...actual, meteoraPoolSource: { ...actual.meteoraPoolSource, loadProfile: fake.loadProfile, readLiquidity: fake.readLiquidity,
    assemble: (poolId: string) => payloadFixture({ poolId }) } };
});
import { METEORA_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/meteora/constants";
import { MeteoraDatapiError } from "./range-apr/meteora-datapi-history";
import { METEORA_APR_POOL_TIMEOUT_MS, METEORA_APR_POOLS_PER_RUN, runJob } from "./rwa-refresh";
import { ThrottleGate } from "./range-apr/throttle-gate";
import { FEED_KEY, FEED_KEY_METEORA, storeRequestSchema, type ActivePool, type RwaStore } from "./rwa-store-types";

const now = Date.parse("2026-11-01T04:00:00Z");
const profile = { economics: { mintA: "x", mintB: "y" }, candles: [{ timestamp: 1 }], stale: false, daily: null, issues: [],
  observedAt: { economics: "2026-11-01T03:59:00Z", daily: null, hourly: "2026-11-01T03:59:00Z" } };
function pool(id: string, tvlUsd: number, refreshedAt: string | null): ActivePool {
  return { pair: { poolAddress: id, mintA: "x", mintB: "y", protocol: "meteora-dlmm", binStep: 1, tvlUsd } as ActivePool["pair"],
    metricsObservedAt: null, profile: null, refreshedAt } as unknown as ActivePool;
}
function store(meteora: ActivePool[]) {
  const calls: { op: string; feedKeys?: string[]; data?: { poolId: string; protocol?: string; payload: unknown; issues?: string[] } }[] = [];
  const finishes: { outcome: string; failure?: boolean }[] = [];
  const s = { request: async (input: (typeof calls)[number]) => {
    calls.push(input);
    if (input.op === "finish") finishes.push(input as unknown as (typeof finishes)[number]);
    if (input.op === "claim") return { job: "rwa-apr-refresh", token: "t" };
    if (input.op === "activePools") {
      storeRequestSchema.parse(input); // the real store's request contract (feed lists are Raydium-first)
      const raydium = { ...pool("ray-in-both-feeds", 1e9, null), pair: { poolAddress: "ray-in-both-feeds", protocol: "raydium-clmm", tvlUsd: 1e9 } };
      return input.feedKeys?.includes(FEED_KEY_METEORA) ? [raydium, ...meteora] : [];
    }
    // Today's Meteora TVL is already stored (dex/meteora-dlmm/daily-tvl.server.test.ts covers the record itself).
    if (input.op === "meteoraTvlDay") return { pools: METEORA_ALLOWLISTED_POOLS.map((pool) => pool.poolAddress) };
    return null;
  } } as unknown as RwaStore;
  const saved = () => calls.filter((c) => c.op === "saveApr").map((c) => c.data!);
  return { s, calls, saved, finishes };
}
const run = (s: RwaStore, extra: Record<string, unknown> = {}) => runJob("rwa-apr-refresh",
  { store: s, clock: () => now, deadlineMs: now + 200_000, geckoGate: new ThrottleGate({ minSpacingMs: 0 }), meteoraScan: true, ...extra });
const ok = () => {
  fake.loadProfile.mockImplementation(async () => {
    fake.active += 1; fake.peak = Math.max(fake.peak, fake.active);
    await new Promise((r) => setTimeout(r, 5));
    fake.active -= 1;
    return profile;
  });
  fake.readLiquidity.mockResolvedValue({ mintA: "x", mintB: "y" });
};
afterEach(() => { vi.clearAllMocks(); fake.active = 0; fake.peak = 0; });

describe("APR job: Meteora lane", () => {
  it("off: no Meteora pools read, prepareDaily keeps the Raydium feed only, no lane stats", async () => {
    const { s, calls } = store([pool("m1", 9_000, null)]);
    const result = await run(s, { meteoraScan: false });
    expect(calls.find((c) => c.op === "prepareDaily")).not.toHaveProperty("feedKeys");
    expect(calls.filter((c) => c.op === "activePools").every((c) => c.feedKeys === undefined)).toBe(true);
    expect(fake.loadProfile).not.toHaveBeenCalled();
    expect(result.meteoraQueue).toBeUndefined();
  });

  it("on: TVL ≥ $5k only, oldest first, at most 8 per run, 3 at a time, saved under meteora-dlmm with the stored row", async () => {
    ok();
    const pools = [pool("small", 4_999, null), ...Array.from({ length: 10 }, (_, i) =>
      pool(`m${i}`, 10_000, `2026-11-01T0${i < 5 ? 3 : 2}:${String(10 + i).padStart(2, "0")}:00Z`))];
    const { s, calls, saved } = store(pools);
    const result = await run(s);
    expect(calls.find((c) => c.op === "prepareDaily")).toMatchObject({ feedKeys: [FEED_KEY, FEED_KEY_METEORA] });
    expect(result.meteoraQueue).toEqual({ pools: 10, selected: METEORA_APR_POOLS_PER_RUN, done: 8, stoppedBy: null, failed: 0 });
    expect(saved().map((d) => d.poolId).sort()).toEqual(["m0", "m1", "m2", "m5", "m6", "m7", "m8", "m9"]);
    expect(saved().every((d) => d.protocol === "meteora-dlmm" && d.payload)).toBe(true);
    expect(fake.peak).toBeLessThanOrEqual(3);
    expect(fake.peak).toBeGreaterThan(1);
    expect(fake.loadProfile.mock.calls[0]![3]).toMatchObject({ pair: { binStep: 1 } });
    expect(fake.readLiquidity.mock.calls[0]![2]).toMatchObject({ binStep: 1 });
    expect(result.status).toBe("ok");
  });

  it("a datapi 429 ends the lane: that pool saves nothing, the job is partial but not a failure", async () => {
    fake.readLiquidity.mockResolvedValue({ mintA: "x", mintB: "y" });
    fake.loadProfile.mockRejectedValue(new MeteoraDatapiError("datapi-429", "datapi 429"));
    const { s, saved, finishes } = store([pool("m1", 9_000, null), pool("m2", 9_000, null), pool("m3", 9_000, null), pool("m4", 9_000, null)]);
    const result = await run(s);
    expect(saved()).toEqual([]);
    expect(result.meteoraQueue).toMatchObject({ stoppedBy: "datapi-429", done: 0 });
    expect(fake.loadProfile.mock.calls.length).toBeLessThanOrEqual(3);
    expect(result.status).toBe("partial");
    expect(finishes[0]).toMatchObject({ outcome: "partial", failure: false });
  });

  it("a pool past its time limit saves an error (so it rotates) and the lane goes on", async () => {
    fake.loadProfile.mockImplementation(async (poolId: string, _f: unknown, _n: unknown, upstream: { retry: { signal: AbortSignal } }) => {
      if (poolId !== "slow") return profile;
      return new Promise((_, reject) => upstream.retry.signal.addEventListener("abort", () => reject(upstream.retry.signal.reason)));
    });
    fake.readLiquidity.mockResolvedValue({ mintA: "x", mintB: "y" });
    const { s, saved } = store([pool("slow", 9_000, null), pool("fast", 9_000, "2026-11-01T03:00:00Z")]);
    const result = await run(s, { meteoraPoolTimeoutMs: 50 });
    const slow = saved().find((d) => d.poolId === "slow")!;
    expect(slow).toMatchObject({ protocol: "meteora-dlmm", payload: null });
    expect(slow.issues![0]).toMatch(/timed out/);
    expect(saved().find((d) => d.poolId === "fast")?.payload).toBeTruthy();
    expect(result.meteoraQueue).toMatchObject({ done: 2, failed: 1, stoppedBy: null });
    expect(result.status).toBe("partial");
  });

  it("starts no pool when the job deadline cannot fit a pool's limit plus the save reserve", async () => {
    ok();
    const { s, saved } = store([pool("m1", 9_000, null)]);
    const result = await run(s, { deadlineMs: now + METEORA_APR_POOL_TIMEOUT_MS });
    expect(saved()).toEqual([]);
    expect(result.meteoraQueue).toMatchObject({ stoppedBy: "time", done: 0 });
  });

  it("a row without a bin step is an error for that pool, never a guess", async () => {
    const { meteoraPoolSource } = await vi.importActual<typeof import("./pool-sources/meteora")>("./pool-sources/meteora");
    const row = { poolAddress: "p", mintA: "x", mintB: "y" };
    expect(() => meteoraPoolSource.readLiquidity("p", {} as never, row)).toThrow(/bin step/);
    expect(meteoraPoolSource.isThrottleError!(new MeteoraDatapiError("datapi-429", "x"))).toBe(true);
    expect(meteoraPoolSource.isThrottleError!(new Error("datapi 429"))).toBe(false);
  });
});
