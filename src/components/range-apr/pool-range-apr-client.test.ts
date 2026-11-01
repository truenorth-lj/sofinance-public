import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { degradedPayloadFixture, payloadFixture } from "@/lib/range-apr/payload.fixture";
import { clearPoolRangeAprClientCache, loadPoolRangeApr, rangeAprUrl } from "./pool-range-apr-client";

let payloads: unknown[];
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payloads.shift() }));

beforeEach(() => {
  vi.useFakeTimers();
  payloads = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  clearPoolRangeAprClientCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("loadPoolRangeApr cache", () => {
  it("serves a good payload for a minute without asking again", async () => {
    payloads = [payloadFixture()];
    await loadPoolRangeApr("pool");
    vi.advanceTimersByTime(59_000);
    await loadPoolRangeApr("pool");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a degraded payload only a few seconds, so the next ask reaches the server", async () => {
    payloads = [degradedPayloadFixture(), payloadFixture()];
    expect((await loadPoolRangeApr("pool")).sample.degraded).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect((await loadPoolRangeApr("pool")).sample.degraded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4_000);
    expect((await loadPoolRangeApr("pool")).sample.degraded).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("loadPoolRangeApr protocols", () => {
  it("asks the protocol-pools range APR route for Orca / Meteora and keeps their cache apart from Raydium", async () => {
    payloads = [payloadFixture(), payloadFixture()];
    await loadPoolRangeApr("pool");
    await loadPoolRangeApr("pool", "meteora-dlmm");
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(urls[0]).toContain("/api/pool-range-apr");
    expect(urls[1]).toContain("/api/protocol-pools/range-apr");
    expect(urls[1]).toContain("protocol=meteora-dlmm");
  });
});

describe("rangeAprUrl (Meteora pools of the RWA list)", () => {
  const meteora = "5pw5tNUaZJpUCnYjZ1V3gd7XkLbrb4zA9pir4LFph2mj";
  const raydium = "6g65bzgeTNLeq9ubXPKvw7huT1s9JjMDjmbYYVkY1jCZ";
  const rhc = "0x4f54c74021e4139bbc4c7bc924346c921975136ea120cf118a93c43b50bdbd3c";

  it("sends a Meteora pool of the RWA list to the saved snapshot route", () => {
    expect(rangeAprUrl(meteora, "meteora-dlmm", { rwaList: true })).toBe(`/api/pool-range-apr?poolId=${meteora}`);
  });

  it("keeps Raydium, RHC and discovery-only Meteora URLs byte-identical", () => {
    for (const options of [undefined, {}, { rwaList: false }, { rwaList: true }]) {
      expect(rangeAprUrl(raydium, "raydium-clmm", options)).toBe(`/api/pool-range-apr?poolId=${raydium}`);
      expect(rangeAprUrl(rhc, "uniswap-v4-rhc", options)).toBe(`/api/protocol-pools/range-apr?protocol=uniswap-v4-rhc&poolId=${rhc}`);
    }
    expect(rangeAprUrl(meteora, "meteora-dlmm")).toBe(`/api/protocol-pools/range-apr?protocol=meteora-dlmm&poolId=${meteora}`);
    expect(rangeAprUrl(meteora, "meteora-dlmm", { rwaList: false })).toBe(`/api/protocol-pools/range-apr?protocol=meteora-dlmm&poolId=${meteora}`);
  });

  it("fetches the saved snapshot for an RWA-list Meteora pool, cached apart from the discovery route", async () => {
    payloads = [payloadFixture(), payloadFixture(), payloadFixture()];
    await loadPoolRangeApr(meteora, "meteora-dlmm", { rwaList: true });
    await loadPoolRangeApr(meteora, "meteora-dlmm");
    await loadPoolRangeApr(raydium);
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(urls).toEqual([
      `/api/pool-range-apr?poolId=${meteora}`,
      `/api/protocol-pools/range-apr?protocol=meteora-dlmm&poolId=${meteora}`,
      `/api/pool-range-apr?poolId=${raydium}`,
    ]);
  });
});
