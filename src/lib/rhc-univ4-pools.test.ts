import { beforeEach, describe, expect, it, vi } from "vitest";
import dexScreenerCapture from "../../packages/engine/src/fixtures/univ4-rhc-spcx-dexscreener.json";

vi.mock("server-only", () => ({}));
import { createRhcClients, resetEvmRpcGuards } from "@sofinance/engine/rpc-evm/index";
import { mockRhcChain, mockRhcTransport } from "@sofinance/engine/test-support/rhc-mock-rpc";
import { discoverRhcUniv4Pools, resetRhcUniv4PoolsCache, takeGeckoTerminalSlot } from "./rhc-univ4-pools";

beforeEach(() => { resetRhcUniv4PoolsCache(); resetEvmRpcGuards(); });

const indexer = () => {
  const hits: string[] = [];
  const fetcher = (async (url: string) => {
    hits.push(new URL(url).hostname);
    return new Response(JSON.stringify(dexScreenerCapture), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { hits, fetcher };
};

describe("discoverRhcUniv4Pools (mock Robinhood Chain RPC + DexScreener capture)", () => {
  it("returns a JSON-safe read-only payload with indexer APR, and caches it", async () => {
    const chain = mockRhcChain();
    const { hits, fetcher } = indexer();
    const clients = createRhcClients({ env: {}, transportFor: () => mockRhcTransport(chain) });
    const result = await discoverRhcUniv4Pools({ clients, fetcher });
    expect(result).toMatchObject({ protocol: "uniswap-v4-rhc", chainId: 4663, readOnly: true, aprLabel: { zh: "估計", en: "Estimated" } });
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({ baseSymbol: "SPCX", status: "listed", dynamicFeePips: { zeroForOne: 50, oneForZero: 51 },
      estimatedApr: { estimated: true, label: { zh: "估計", en: "Estimated" }, source: "dexscreener", volume24hUsd: 36.54, tvlUsd: 48711.43 } });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(chain.calls.some(call => call.method === "eth_getLogs")).toBe(false);
    const calls = chain.calls.length;
    expect(await discoverRhcUniv4Pools({ clients, fetcher })).toBe(result);
    expect(chain.calls).toHaveLength(calls);
    // Market data is cached separately (2 min): a state refresh does not call the indexer again.
    await discoverRhcUniv4Pools({ clients, fetcher, bypassCache: true });
    // One DexScreener call (24h) and one GeckoTerminal daily-candle call (7d); both cached past a state refresh.
    expect(hits).toEqual(["api.dexscreener.com", "api.geckoterminal.com"]);
  });

  it("reports the pool as delisted when the hook implementation changes", async () => {
    const chain = mockRhcChain();
    chain.implementation = "0x000000000000000000000000000000000000bEEF";
    const clients = createRhcClients({ env: {}, transportFor: () => mockRhcTransport(chain) });
    const { pools } = await discoverRhcUniv4Pools({ clients, fetcher: indexer().fetcher, bypassCache: true });
    expect(pools[0]).toMatchObject({ status: "delisted", delistReasons: ["hook-implementation"] });
  });

  it("keeps the pool listed without APR when the indexers are unavailable", async () => {
    const clients = createRhcClients({ env: {}, transportFor: () => mockRhcTransport(mockRhcChain()) });
    const fetcher = (async () => new Response("busy", { status: 429 })) as unknown as typeof fetch;
    const { pools } = await discoverRhcUniv4Pools({ clients, fetcher, bypassCache: true });
    expect(pools[0]).toMatchObject({ status: "listed", estimatedApr: null });
  });
});

describe("7-day pool fee APR (GeckoTerminal daily volume, no RPC)", () => {
  it("adds estimatedApr7d from daily candles × the hook fee / DexScreener TVL", async () => {
    const chain = mockRhcChain();
    const clients = createRhcClients({ env: {}, transportFor: () => mockRhcTransport(chain) });
    const lastDay = Math.floor(Date.now() / 86_400_000) * 86_400 - 86_400;
    const daily = { data: { attributes: { ohlcv_list: [[lastDay, 1, 1, 1, 1, 70], [lastDay - 3 * 86_400, 1, 1, 1, 1, 70], [lastDay - 6 * 86_400, 1, 1, 1, 1, 70]] } } };
    const fetcher = (async (url: string) => new Response(JSON.stringify(url.includes("geckoterminal") ? daily : dexScreenerCapture), { status: 200 })) as unknown as typeof fetch;
    const before = chain.calls.length;
    const { pools } = await discoverRhcUniv4Pools({ clients, fetcher, bypassCache: true });
    expect(pools[0]!.estimatedApr7d).toMatchObject({ days: 7, avgDailyVolumeUsd: 30, tvlUsd: 48711.43, source: "geckoterminal" });
    expect(pools[0]!.estimatedApr7d!.estimatedPoolFeeAprPct).toBeCloseTo(0.0000505 * 30 / 48711.43 * 365 * 100, 12);
    // Same RPC reads as without the 7-day figure (block + multicall + storage slot).
    expect(chain.calls.slice(before).map(call => call.method).sort()).toEqual(["eth_call", "eth_getBlockByNumber", "eth_getStorageAt"]);
  });

  it("is null when GeckoTerminal is unavailable (the UI shows —)", async () => {
    const clients = createRhcClients({ env: {}, transportFor: () => mockRhcTransport(mockRhcChain()) });
    const fetcher = (async (url: string) => url.includes("geckoterminal") ? new Response("busy", { status: 429 })
      : new Response(JSON.stringify(dexScreenerCapture), { status: 200 })) as unknown as typeof fetch;
    const { pools } = await discoverRhcUniv4Pools({ clients, fetcher, bypassCache: true });
    expect(pools[0]!.estimatedApr).not.toBeNull();
    expect(pools[0]!.estimatedApr7d).toBeNull();
  });
});

describe("GeckoTerminal fallback budget", () => {
  beforeEach(() => resetRhcUniv4PoolsCache());
  it("allows at most 4 fallback calls per rolling minute", () => {
    const t0 = 1_000_000;
    expect([0, 1, 2, 3, 4].map(i => takeGeckoTerminalSlot(t0 + i))).toEqual([true, true, true, true, false]);
    expect(takeGeckoTerminalSlot(t0 + 59_999)).toBe(false);
    expect(takeGeckoTerminalSlot(t0 + 60_001)).toBe(true);
  });
});
