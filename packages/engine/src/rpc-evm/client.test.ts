import { custom } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { createRhcClient, resetEvmRpcGuards, resolveEvmProviders, type EvmRpcEvent, type EvmRpcProviderId } from ".";

beforeEach(() => resetEvmRpcGuards());

type Behaviour = "ok" | "fail" | "429";
function harness(behaviour: Partial<Record<EvmRpcProviderId, Behaviour>>, env: Record<string, string | undefined> = {}, now = () => 0) {
  const hits: EvmRpcProviderId[] = [];
  const events: EvmRpcEvent[] = [];
  const make = (route: "state" | "logs") => createRhcClient(route, {
    env, now, onEvent: event => events.push(event),
    transportFor: provider => custom({
      request: async ({ method }) => {
        hits.push(provider.id);
        const mode = behaviour[provider.id] ?? "ok";
        if (mode === "fail") throw new Error("upstream unavailable");
        if (mode === "429") throw new Error("HTTP 429 Too Many Requests");
        if (method === "eth_blockNumber") return "0x10";
        throw new Error(`unsupported ${method}`);
      },
    }, { retryCount: 0 }),
  });
  return { hits, events, make };
}

describe("rpc-evm provider catalog", () => {
  it("orders state providers dRPC → PublicNode → official and keeps logs off the free tiers", () => {
    expect(resolveEvmProviders("state", {}).map(provider => provider.id)).toEqual(["drpc", "publicnode", "official"]);
    expect(resolveEvmProviders("logs", {}).map(provider => provider.id)).toEqual(["official"]);
    expect(resolveEvmProviders("state", {}).map(provider => provider.url)).toEqual([
      "https://robinhood.drpc.org", "https://robinhood-rpc.publicnode.com", "https://rpc.mainnet.chain.robinhood.com",
    ]);
  });

  it("puts an optional dedicated RHC_RPC_URL first on both routes", () => {
    const env = { RHC_RPC_URL: " https://dedicated.example/v2/KEY " };
    expect(resolveEvmProviders("state", env).map(provider => provider.id)).toEqual(["dedicated", "drpc", "publicnode", "official"]);
    expect(resolveEvmProviders("logs", env)[0]).toMatchObject({ id: "dedicated", url: "https://dedicated.example/v2/KEY" });
    expect(resolveEvmProviders("state", { RHC_RPC_URL: "  " })[0]!.id).toBe("drpc");
  });
});

describe("rpc-evm client", () => {
  it("uses the first healthy provider and falls back in order", async () => {
    const { hits, make } = harness({ drpc: "fail" });
    expect(await make("state").getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(hits).toEqual(["drpc", "publicnode"]);
  });

  it("overflows to the next provider when a local budget is spent, without calling it", async () => {
    const { hits, events, make } = harness({});
    const client = make("state");
    for (let i = 0; i < 9; i++) await client.getBlockNumber({ cacheTime: 0 });
    // dRPC burst is 8 (clock frozen), so call 9 goes to PublicNode.
    expect(hits.filter(id => id === "drpc")).toHaveLength(8);
    expect(hits.at(-1)).toBe("publicnode");
    expect(events.some(event => event.provider === "drpc" && event.outcome === "quota")).toBe(true);
  });

  it("keeps the official RPC on a low budget and cools down after a 429", async () => {
    let t = 0;
    const { hits, make } = harness({ official: "429" }, {}, () => t);
    const logs = make("logs");
    await expect(logs.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    await expect(logs.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(hits).toEqual(["official"]);
    t = 31_000;
    await expect(logs.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(hits).toEqual(["official", "official"]);
  });

  it("never exposes provider URLs (or keys) in events", async () => {
    const { events, make } = harness({ dedicated: "fail" }, { RHC_RPC_URL: "https://dedicated.example/v2/SECRETKEY" });
    await make("state").getBlockNumber({ cacheTime: 0 });
    expect(events.map(event => event.provider)).toEqual(["dedicated", "drpc"]);
    expect(JSON.stringify(events)).not.toMatch(/https?:|SECRETKEY/);
  });
});
