import { custom } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createRhcClient, isUnsupportedRpcMethod, orderProvidersForMethod, resetEvmRpcGuards, resolveEvmProviders,
  SIMULATION_PROVIDER_ORDER, type EvmRpcEvent, type EvmRpcProviderId,
} from ".";

beforeEach(() => resetEvmRpcGuards());

type Behaviour = "ok" | "fail" | "429" | "unsupported";
type BehaviourMap = Partial<Record<EvmRpcProviderId, Behaviour | Partial<Record<string, Behaviour>>>>;

function modeOf(behaviour: BehaviourMap, id: EvmRpcProviderId, method: string): Behaviour {
  const raw = behaviour[id];
  if (!raw) return "ok";
  if (typeof raw === "string") return raw;
  return raw[method] ?? "ok";
}

function harness(behaviour: BehaviourMap, env: Record<string, string | undefined> = {}, now = () => 0) {
  const hits: { id: EvmRpcProviderId; method: string }[] = [];
  const events: EvmRpcEvent[] = [];
  const make = (route: "state" | "logs") => createRhcClient(route, {
    env, now, onEvent: event => events.push(event),
    transportFor: provider => custom({
      request: async ({ method }) => {
        hits.push({ id: provider.id, method });
        const mode = modeOf(behaviour, provider.id, method);
        if (mode === "fail") throw new Error("upstream unavailable");
        if (mode === "429") throw new Error("HTTP 429 Too Many Requests");
        if (mode === "unsupported") {
          throw Object.assign(new Error(`the method ${method} does not exist/is not available`), { code: -32601 });
        }
        if (method === "eth_blockNumber") return "0x10";
        if (method === "eth_estimateGas") return "0x5208";
        if (method === "eth_simulateV1") return [{ calls: [] }];
        throw new Error(`unexpected ${method}`);
      },
    }, { retryCount: 0 }),
  });
  return { hits, events, make };
}

const DEDICATED = { RHC_RPC_URL: " https://dedicated.example/v2/KEY " };

describe("rpc-evm provider catalog", () => {
  it("orders state providers dRPC → PublicNode → official and keeps logs off the free tiers", () => {
    expect(resolveEvmProviders("state", {}).map(provider => provider.id)).toEqual(["drpc", "publicnode", "official"]);
    expect(resolveEvmProviders("logs", {}).map(provider => provider.id)).toEqual(["official"]);
    expect(resolveEvmProviders("state", {}).map(provider => provider.url)).toEqual([
      "https://robinhood.drpc.org", "https://robinhood-rpc.publicnode.com", "https://rpc.mainnet.chain.robinhood.com",
    ]);
  });

  it("puts an optional dedicated RHC_RPC_URL (Alchemy free: 10-block getLogs cap) first on the state route only, at 4 rps", () => {
    const env = DEDICATED;
    const state = resolveEvmProviders("state", env);
    expect(state.map(provider => provider.id)).toEqual(["dedicated", "drpc", "publicnode", "official"]);
    expect(state[0]).toMatchObject({ id: "dedicated", url: "https://dedicated.example/v2/KEY", rps: 4, burst: 20 });
    expect(resolveEvmProviders("logs", env).map(provider => provider.id)).toEqual(["official"]);
    expect(resolveEvmProviders("state", { RHC_RPC_URL: "  " })[0]!.id).toBe("drpc");
  });

  it("routes eth_simulateV1 and eth_estimateGas dRPC → PublicNode → official, Alchemy last", () => {
    expect(SIMULATION_PROVIDER_ORDER).toEqual(["drpc", "publicnode", "official", "dedicated"]);
    const state = resolveEvmProviders("state", DEDICATED);
    expect(orderProvidersForMethod("state", "eth_simulateV1", state).map(provider => provider.id))
      .toEqual(["drpc", "publicnode", "official", "dedicated"]);
    expect(orderProvidersForMethod("state", "eth_estimateGas", state).map(provider => provider.id))
      .toEqual(["drpc", "publicnode", "official", "dedicated"]);
    expect(orderProvidersForMethod("state", "eth_call", state).map(provider => provider.id))
      .toEqual(["dedicated", "drpc", "publicnode", "official"]);
    expect(orderProvidersForMethod("state", "eth_getBlockByNumber", state).map(provider => provider.id))
      .toEqual(["dedicated", "drpc", "publicnode", "official"]);
    expect(orderProvidersForMethod("logs", "eth_simulateV1", resolveEvmProviders("logs", DEDICATED)).map(provider => provider.id))
      .toEqual(["official"]);
    expect(orderProvidersForMethod("state", "eth_simulateV1", resolveEvmProviders("state", {})).map(provider => provider.id))
      .toEqual(["drpc", "publicnode", "official"]);
  });
});

describe("isUnsupportedRpcMethod", () => {
  it("recognises JSON-RPC -32601 and common unsupported-method wording, not a 429", () => {
    expect(isUnsupportedRpcMethod(Object.assign(new Error("the method eth_simulateV1 does not exist/is not available"), { code: -32601 }))).toBe(true);
    expect(isUnsupportedRpcMethod(new Error("method not found"))).toBe(true);
    expect(isUnsupportedRpcMethod(new Error("method eth_simulateV1 is not supported"))).toBe(true);
    expect(isUnsupportedRpcMethod(new Error("HTTP 429 Too Many Requests"))).toBe(false);
    expect(isUnsupportedRpcMethod(new Error("upstream unavailable"))).toBe(false);
  });
});

describe("rpc-evm client", () => {
  it("uses the first healthy provider and falls back in order", async () => {
    const { hits, make } = harness({ drpc: "fail" });
    expect(await make("state").getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(hits.map(hit => hit.id)).toEqual(["drpc", "publicnode"]);
  });

  it("overflows to the next provider when a local budget is spent, without calling it", async () => {
    const { hits, events, make } = harness({});
    const client = make("state");
    for (let i = 0; i < 9; i++) await client.getBlockNumber({ cacheTime: 0 });
    // dRPC burst is 8 (clock frozen), so call 9 goes to PublicNode.
    expect(hits.filter(hit => hit.id === "drpc")).toHaveLength(8);
    expect(hits.at(-1)?.id).toBe("publicnode");
    expect(events.some(event => event.provider === "drpc" && event.outcome === "quota")).toBe(true);
  });

  it("keeps the official RPC on a low budget and cools down after a 429", async () => {
    let t = 0;
    const { hits, make } = harness({ official: "429" }, {}, () => t);
    const logs = make("logs");
    await expect(logs.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    await expect(logs.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(hits.map(hit => hit.id)).toEqual(["official"]);
    t = 31_000;
    await expect(logs.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
    expect(hits.map(hit => hit.id)).toEqual(["official", "official"]);
  });

  it("never exposes provider URLs (or keys) in events", async () => {
    const { events, make } = harness({ dedicated: "fail" }, { RHC_RPC_URL: "https://dedicated.example/v2/SECRETKEY" });
    await make("state").getBlockNumber({ cacheTime: 0 });
    expect(events.map(event => event.provider)).toEqual(["dedicated", "drpc"]);
    expect(JSON.stringify(events)).not.toMatch(/https?:|SECRETKEY/);
  });

  it("sends eth_simulateV1 and eth_estimateGas to dRPC first, Alchemy last, and leaves other methods on the catalog order", async () => {
    const env = { RHC_RPC_URL: "https://dedicated.example/v2/KEY" };
    const { hits, make } = harness({}, env);
    const client = make("state");
    expect(await client.request({ method: "eth_simulateV1" as never, params: [] as never })).toEqual([{ calls: [] }]);
    expect(await client.estimateGas({ account: "0x0000000000000000000000000000000000000001", to: "0x0000000000000000000000000000000000000001", data: "0x" })).toBe(0x5208n);
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(hits.map(hit => `${hit.method}@${hit.id}`)).toEqual([
      "eth_simulateV1@drpc",
      "eth_estimateGas@drpc",
      "eth_blockNumber@dedicated",
    ]);
  });

  it("skips a provider that does not support the method, does not count it as a failure, and does not start a 429 cooldown", async () => {
    const env = { RHC_RPC_URL: "https://dedicated.example/v2/KEY" };
    const { hits, events, make } = harness({ drpc: { eth_simulateV1: "unsupported" } }, env);
    const client = make("state");
    expect(await client.request({ method: "eth_simulateV1" as never, params: [] as never })).toEqual([{ calls: [] }]);
    expect(hits.map(hit => `${hit.method}@${hit.id}`)).toEqual(["eth_simulateV1@drpc", "eth_simulateV1@publicnode"]);
    expect(events).toEqual([
      { route: "state", provider: "drpc", method: "eth_simulateV1", outcome: "unsupported" },
      { route: "state", provider: "publicnode", method: "eth_simulateV1", outcome: "ok" },
    ]);
    // No cooldown: the next ordinary read still starts at dedicated, and the next simulate still tries dRPC first.
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(await client.request({ method: "eth_simulateV1" as never, params: [] as never })).toEqual([{ calls: [] }]);
    expect(hits.map(hit => `${hit.method}@${hit.id}`)).toEqual([
      "eth_simulateV1@drpc", "eth_simulateV1@publicnode",
      "eth_blockNumber@dedicated",
      "eth_simulateV1@drpc", "eth_simulateV1@publicnode",
    ]);
    expect(events.filter(event => event.outcome === "error" || event.outcome === "quota")).toEqual([]);
  });
});
