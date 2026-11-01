import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({ discover: vi.fn(), profile: vi.fn(), liquidity: vi.fn() }));
vi.mock("../rwa-pairs", async (load) => ({ ...await load<object>(), discoverRwaPairs: calls.discover }));
vi.mock("../pool-range-apr", async (load) => ({ ...await load<object>(), loadVolumeProfile: calls.profile }));
vi.mock("../range-apr/onchain-liquidity", () => ({ readOnchainPoolLiquidity: calls.liquidity }));
import { POOL_PROTOCOL_IDS } from "@sofinance/engine/protocols/types";
import { RAYDIUM_ECONOMICS_SOURCE } from "../pool-range-apr";
import { FEED_KEY } from "../rwa-store-types";
import { solanaIconSources } from "../token-icons/resolve";
import { POOL_SOURCES, poolSourceFor, scanPoolSources } from "./registry";
import { raydiumPoolSource } from "./raydium";

describe("pool source registry", () => {
  it("registers Raydium only, under the existing feed key", () => {
    expect(POOL_SOURCES.map((source) => source.id)).toEqual(["raydium-clmm"]);
    expect(scanPoolSources()).toBe(POOL_SOURCES);
    expect(raydiumPoolSource).toMatchObject({ chain: "solana", feedKey: FEED_KEY, displayName: "Raydium", economics: RAYDIUM_ECONOMICS_SOURCE });
    expect(raydiumPoolSource.presets).toBeUndefined();
  });

  it("refreshes every stored protocol (and rows without one) on the Raydium path, as the cron did before", () => {
    for (const protocol of [...POOL_PROTOCOL_IDS, undefined]) expect(poolSourceFor(protocol)).toBe(raydiumPoolSource);
  });
});

describe("raydiumPoolSource passes arguments through unchanged", () => {
  it("discover", async () => {
    const result = { pairs: [] };
    calls.discover.mockResolvedValue(result);
    const options = { minTvl: 0, maxPages: 10, sortBy: "estimatedFeeApr" as const, signal: new AbortController().signal };
    await expect(raydiumPoolSource.discover(options)).resolves.toBe(result);
    expect(calls.discover).toHaveBeenCalledWith(options);
  });

  it("loadProfile: no economics override, same upstream object", async () => {
    const profile = { economics: {} };
    calls.profile.mockResolvedValue(profile);
    const upstream = { retry: { signal: new AbortController().signal } };
    await expect(raydiumPoolSource.loadProfile("pool", fetch, 123, upstream)).resolves.toBe(profile);
    expect(calls.profile).toHaveBeenCalledWith("pool", fetch, 123, upstream);
    expect(calls.profile.mock.calls[0]![3]).toBe(upstream);
  });

  it("readLiquidity", async () => {
    const chain = { mintA: "a" };
    const connection = {} as never;
    calls.liquidity.mockResolvedValue(chain);
    await expect(raydiumPoolSource.readLiquidity("pool", connection)).resolves.toBe(chain);
    expect(calls.liquidity).toHaveBeenCalledWith("pool", connection);
  });

  it("iconSources: Jupiter then Raydium", () => {
    expect(raydiumPoolSource.iconSources().map((entry) => entry.source)).toEqual(solanaIconSources().map((entry) => entry.source));
    expect(raydiumPoolSource.iconSources().map((entry) => entry.source)).toEqual(["jupiter", "raydium"]);
  });
});
