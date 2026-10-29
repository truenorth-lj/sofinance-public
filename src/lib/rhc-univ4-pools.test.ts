import { beforeEach, describe, expect, it, vi } from "vitest";
import dexScreenerCapture from "../../packages/engine/src/fixtures/univ4-rhc-spcx-dexscreener.json";

vi.mock("server-only", () => ({}));
import { createRhcClients, resetEvmRpcGuards } from "@sofinance/engine/rpc-evm/index";
import { mockRhcChain, mockRhcTransport } from "@sofinance/engine/test-support/rhc-mock-rpc";
import { discoverRhcUniv4Pools, resetRhcUniv4PoolsCache } from "./rhc-univ4-pools";

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
    expect(hits).toEqual(["api.dexscreener.com"]);
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
