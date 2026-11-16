import { beforeEach, expect, it, vi } from "vitest";
import { dexRegistry, poolCronPolicyFor, publishPoolCron, refreshPoolCron, type PoolCronDiscoveryInput, type PoolCronLaneInput } from "./index";
import { createDexRegistry } from "./registry";
import { meteoraDlmmModule } from "./meteora-dlmm/module";
import { DexUnsupportedError } from "./errors";
import { ThrottleGate } from "@/lib/range-apr/throttle-gate";
import type { RwaPairRow } from "@/lib/rwa-pairs";
import type { RwaStore } from "@/lib/rwa-store-types";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ loaded: false, publish: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/dex/meteora-dlmm/cron.server", () => {
  backend.loaded = true;
  return { publishMeteoraFeed: backend.publish, refreshMeteoraLane: backend.refresh };
});
beforeEach(() => vi.resetAllMocks());
function context(): PoolCronLaneInput {
  return { store: {} as RwaStore, lease: { job: "rwa-apr-refresh", owner: "original", epoch: 1 },
    fetcher: vi.fn<typeof fetch>(), clock: () => 1000, signal: new AbortController().signal,
    gate: new ThrottleGate({ minSpacingMs: 0 }), jobDeadline: 9000 };
}
it("reads policy and rejects unbound DEX ids without loading a cron implementation", async () => {
  expect(backend.loaded).toBe(false);
  const policy = poolCronPolicyFor("meteora-dlmm");
  expect(policy).toEqual({ poolsPerRun: 8, poolTimeoutMs: 10_000 });
  (policy as { poolsPerRun: number }).poolsPerRun = 99;
  expect(poolCronPolicyFor("meteora-dlmm").poolsPerRun).toBe(8);
  for (const id of ["unknown", "raydium-clmm", "orca-whirlpool", "uniswap-v4-rhc", "rhc-uniswap-v4"]) {
    expect(() => poolCronPolicyFor(id)).toThrow(DexUnsupportedError);
    await expect(publishPoolCron(id, {} as PoolCronDiscoveryInput)).rejects.toBeInstanceOf(DexUnsupportedError);
    await expect(refreshPoolCron(id, {} as PoolCronLaneInput)).rejects.toBeInstanceOf(DexUnsupportedError);
  }
  expect(backend.loaded).toBe(false);
});
it("captures lease authority and discovery seeds before lazy loading without copying live dependencies", async () => {
  const scope = context();
  const input: PoolCronDiscoveryInput = { store: scope.store, lease: { ...scope.lease, job: "rwa-discovery" },
    seedPairs: [{ mintA: "original-a", mintB: "original-b" } as RwaPairRow], fetcher: scope.fetcher, signal: scope.signal };
  const original = { ...input, lease: { ...input.lease }, seedPairs: input.seedPairs.map(pair => ({ ...pair })) };
  const result = { published: 1 };
  backend.publish.mockResolvedValue(result);
  const pending = publishPoolCron("meteora-dlmm", input);
  input.lease.owner = "changed"; input.lease.epoch = 99;
  input.seedPairs[0]!.mintA = "changed"; input.seedPairs = [];
  input.store = {} as RwaStore; input.fetcher = vi.fn<typeof fetch>(); input.signal = new AbortController().signal;
  expect(await pending).toBe(result);
  expect(backend.publish).toHaveBeenCalledExactlyOnceWith(original.store, original.lease, original.seedPairs, original.fetcher, original.signal);
  const args = backend.publish.mock.calls[0]!;
  expect(args[0]).toBe(original.store); expect(args[3]).toBe(original.fetcher); expect(args[4]).toBe(original.signal);
});
it("captures lane terms and shared dependencies, preserving the default and explicit pool timeouts", async () => {
  const input = { ...context(), poolTimeoutMs: 50 }, original = { ...input, lease: { ...input.lease } };
  const result = { processed: 1, issues: [], stats: { pools: 1, selected: 1, done: 1, stoppedBy: null, failed: 0 } };
  backend.refresh.mockResolvedValue(result);
  const pending = refreshPoolCron("meteora-dlmm", input);
  input.lease.owner = "changed"; input.lease.epoch = 99; input.jobDeadline = 1; input.poolTimeoutMs = 999;
  input.store = {} as RwaStore; input.clock = () => 999; input.fetcher = vi.fn<typeof fetch>();
  input.signal = new AbortController().signal; input.gate = new ThrottleGate();
  expect(await pending).toBe(result);
  const captured = backend.refresh.mock.calls[0]![0] as PoolCronLaneInput;
  expect(captured).toEqual(original);
  for (const field of ["store", "clock", "fetcher", "signal", "gate"] as const) expect(captured[field]).toBe(original[field]);
  await dexRegistry.refreshPoolCron("meteora-dlmm", context());
  expect(backend.refresh.mock.calls[1]![0].poolTimeoutMs).toBe(10_000);
});
it("does not couple native cron work to generic HTTP enablement and propagates lane failures", async () => {
  const registry = createDexRegistry([{ ...meteoraDlmmModule, enabled: () => false }]);
  expect(registry.isDisabled("meteora-dlmm", "open")).toBe(true);
  const failure = new Error("datapi unavailable");
  backend.refresh.mockRejectedValue(failure); backend.publish.mockRejectedValue(failure);
  await expect(registry.refreshPoolCron("meteora-dlmm", context())).rejects.toBe(failure);
  const scope = context();
  await expect(registry.publishPoolCron("meteora-dlmm", { store: scope.store, lease: scope.lease, signal: scope.signal, seedPairs: [], fetcher: undefined })).rejects.toBe(failure);
  expect(backend.publish.mock.calls[0]![3]).toBeUndefined();
});
