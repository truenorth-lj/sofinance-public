import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { METEORA_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/meteora/constants";

vi.mock("server-only", () => ({}));
const store = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/rwa-store", () => ({ getRwaStore: () => store }));

import { clearMeteoraPoolListCache, listedMeteoraPool } from "./pools.server";

const FEED_POOL = "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh";
const BLOCKED_POOL = "5pw5tNUaZJpUCnYjZ1V3gd7XkLbrb4zA9pir4LFph2mj";

describe("listedMeteoraPool", () => {
  beforeEach(() => {
    clearMeteoraPoolListCache();
    store.request.mockReset().mockResolvedValue([
      { pair: { poolAddress: FEED_POOL, protocol: "meteora-dlmm", mintA: "A", mintB: "B", blocked: false } },
      { pair: { poolAddress: BLOCKED_POOL, protocol: "meteora-dlmm", mintA: "C", mintB: "D", blocked: true } },
      { pair: { poolAddress: "RaydiumPool", protocol: "raydium-clmm", mintA: "E", mintB: "F" } },
    ]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lists the static allowlist without touching the store", async () => {
    vi.stubEnv("SOFINANCE_RWA_DB_ENABLED", "false");
    const fixed = METEORA_ALLOWLISTED_POOLS[0]!;
    expect(await listedMeteoraPool(fixed.poolAddress)).toEqual({ poolId: fixed.poolAddress, mints: [fixed.mintX, fixed.mintY], binStep: fixed.binStep, source: "allowlist" });
    expect(store.request).not.toHaveBeenCalled();
  });

  it("refuses feed pools while the RWA store is off", async () => {
    vi.stubEnv("SOFINANCE_RWA_DB_ENABLED", "false");
    expect(await listedMeteoraPool(FEED_POOL)).toBeNull();
  });

  it("lists unblocked Meteora feed pools and caches the feed read", async () => {
    vi.stubEnv("SOFINANCE_RWA_DB_ENABLED", "true");
    expect(await listedMeteoraPool(FEED_POOL)).toEqual({ poolId: FEED_POOL, mints: ["A", "B"], binStep: null, source: "rwa-feed" });
    expect(await listedMeteoraPool(BLOCKED_POOL)).toBeNull();
    expect(await listedMeteoraPool("RaydiumPool")).toBeNull();
    expect(store.request).toHaveBeenCalledTimes(1);
    expect(store.request).toHaveBeenCalledWith({ op: "activePools", feedKeys: ["meteora-dlmm-rwa-v1"] });
  });
});
