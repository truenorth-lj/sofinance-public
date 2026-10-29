import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { createRhcClients, resetEvmRpcGuards } from "@sofinance/engine/rpc-evm/index";
import { mockRhcChain, mockRhcTransport } from "@sofinance/engine/test-support/rhc-mock-rpc";
import { discoverRhcUniv4Pools, resetRhcUniv4PoolsCache } from "./rhc-univ4-pools";

beforeEach(() => { resetRhcUniv4PoolsCache(); resetEvmRpcGuards(); });

describe("discoverRhcUniv4Pools (mock Robinhood Chain RPC)", () => {
  it("returns a JSON-safe read-only payload and caches it", async () => {
    const chain = mockRhcChain();
    const clients = createRhcClients({ env: {}, transportFor: () => mockRhcTransport(chain) });
    const result = await discoverRhcUniv4Pools({ clients });
    expect(result).toMatchObject({ protocol: "uniswap-v4-rhc", chainId: 4663, readOnly: true });
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({ baseSymbol: "SPCX", status: "listed", dynamicFeePips: { zeroForOne: 50, oneForZero: 51 } });
    expect(() => JSON.stringify(result)).not.toThrow();
    const calls = chain.calls.length;
    expect(await discoverRhcUniv4Pools({ clients })).toBe(result);
    expect(chain.calls).toHaveLength(calls);
  });

  it("reports the pool as delisted when the hook implementation changes", async () => {
    const chain = mockRhcChain();
    chain.implementation = "0x000000000000000000000000000000000000bEEF";
    const clients = createRhcClients({ env: {}, transportFor: () => mockRhcTransport(chain) });
    const { pools } = await discoverRhcUniv4Pools({ clients, bypassCache: true });
    expect(pools[0]).toMatchObject({ status: "delisted", delistReasons: ["hook-implementation"] });
  });
});
