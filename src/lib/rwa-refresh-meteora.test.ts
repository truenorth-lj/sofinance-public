import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({}) }));
const mocks = vi.hoisted(() => ({ raydium: vi.fn(), meteora: vi.fn() }));
vi.mock("./pool-sources/raydium", async (load) => {
  const actual = await load<typeof import("./pool-sources/raydium")>();
  return { ...actual, raydiumPoolSource: { ...actual.raydiumPoolSource, discover: mocks.raydium, iconSources: () => [] } };
});
vi.mock("./meteora-rwa-scan", async (load) => ({ ...await load<object>(), discoverMeteoraRwaPairs: mocks.meteora }));
vi.mock("./pool-metrics/rhc-discovery", async (load) => ({ ...await load<object>(), discoverRhcRegistryPools: async () => { throw new Error("offline"); } }));
vi.mock("./token-icons/resolve", async (load) => ({ ...await load<object>(), resolveTokenIcons: async () => [] }));

import { runJob } from "./rwa-refresh";
import { FEED_KEY_METEORA, type RwaStore } from "./rwa-store-types";

const scanStats = { seedMints: 3, queries: 6, scannedPools: 40, shapeCandidates: 5, sameAssetPools: 4, excludedBinStep: 1,
  truncatedSeeds: 0, onchainVerified: 3, blocked: 0 };
function discovery(pairs: { poolAddress: string; mintA: string; mintB: string }[]) {
  return { pairs, scannedPools: 40, pagesFetched: 1, fetchedAt: "2026-11-01T00:00:00Z", pairingRuleSummary: "rule", estimatedFeeAprLabel: "label",
    source: "src", discovery: { sourcePages: {}, poolObservedAt: {}, pageCounts: [40], qualificationObservedAt: {} } };
}
function fakeStore() {
  const calls: { op: string; data?: { feedKey?: string; result?: Record<string, unknown> } }[] = [];
  const store = { request: vi.fn(async (input: { op: string; data?: never }) => {
    calls.push(input);
    if (input.op === "claim") return { job: "rwa-discovery", token: "t" };
    if (input.op === "publishDiscovery") return { generation: "g", pools: 1 };
    return undefined;
  }) } as unknown as RwaStore;
  return { store, calls };
}
const RAYDIUM = [{ poolAddress: "ray1", mintA: "MSTRx", mintB: "MSTR" }];

afterEach(() => vi.clearAllMocks());
describe("rwa-discovery with the Meteora scan", () => {
  it("off (flag off): only the Raydium feed is published, the Meteora scan never runs", async () => {
    mocks.raydium.mockResolvedValue(discovery(RAYDIUM));
    const { store, calls } = fakeStore();
    const result = await runJob("rwa-discovery", { store, meteoraScan: false });
    expect(mocks.meteora).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === "publishDiscovery")).toHaveLength(1);
    expect(result).toMatchObject({ status: "ok" });
    expect(result.meteora).toBeUndefined();
  });

  it("on: publishes the meteora feed after Raydium's, seeded with the Raydium feed mints, with the scan counts", async () => {
    mocks.raydium.mockResolvedValue(discovery(RAYDIUM));
    mocks.meteora.mockResolvedValue({ ...discovery([{ poolAddress: "met1", mintA: "a", mintB: "b" }]), meteora: scanStats });
    const { store, calls } = fakeStore();
    const result = await runJob("rwa-discovery", { store, meteoraScan: true });
    const publishes = calls.filter((c) => c.op === "publishDiscovery");
    expect(publishes.map((c) => c.data?.feedKey)).toEqual([undefined, FEED_KEY_METEORA]);
    expect(publishes[1]!.data!.result).toMatchObject({ scanStats: { excludedBinStep: 1 } });
    expect(publishes[1]!.data!.result).not.toHaveProperty("meteora");
    expect(mocks.meteora.mock.calls[0]![0]).toMatchObject({ seedMints: ["MSTRx", "MSTR"], minTvl: 5_000 });
    expect(result).toMatchObject({ status: "ok", processed: 1, meteora: { ...scanStats, published: 1 } });
  });

  it("a Meteora failure is an issue (job partial) but not a discovery failure, and Raydium's publish stands", async () => {
    mocks.raydium.mockResolvedValue(discovery(RAYDIUM));
    mocks.meteora.mockRejectedValue(new Error("datapi pools token_x HTTP 429"));
    const { store, calls } = fakeStore();
    const result = await runJob("rwa-discovery", { store, meteoraScan: true });
    expect(calls.filter((c) => c.op === "publishDiscovery")).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.issues.some((issue) => issue.startsWith("Meteora:"))).toBe(true);
    expect(calls.find((c) => c.op === "finish")).toMatchObject({ outcome: "partial", failure: false });
  });

  it("a Raydium failure still fails the job and skips the Meteora scan", async () => {
    mocks.raydium.mockRejectedValue(new Error("raydium down"));
    const { store, calls } = fakeStore();
    const result = await runJob("rwa-discovery", { store, meteoraScan: true });
    expect(mocks.meteora).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(calls.find((c) => c.op === "finish")).toMatchObject({ outcome: "error", failure: true });
  });
});
