import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { prepareNativeAprRun, type NativeAprRunInput } from "./index";
import { ThrottleGate } from "@/lib/range-apr/throttle-gate";
import type { RwaStore } from "@/lib/rwa-store-types";
import type { PublicClient } from "viem";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("@/lib/dex/uniswap-v4-rhc/apr-refresh.server", () => ({ prepareRhcRun: backend.prepare }));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());
const stats = () => ({ fetched: 0, rolledForward: 0, reused: 0, deferred: 0, failedFetches: 0, stateRpcRequests: 0 });
function context(): NativeAprRunInput {
  return { store: {} as RwaStore, lease: { job: "rwa-apr-refresh", owner: "original-owner", epoch: 1 },
    fetcher: vi.fn<typeof fetch>(), clock: () => 1000, signal: new AbortController().signal,
    gate: new ThrottleGate({ minSpacingMs: 0 }), client: {} as PublicClient };
}
it("captures lease authority and live job dependencies before lazy loading", async () => {
  const input = context(), original = { ...input, lease: { ...input.lease } };
  backend.prepare.mockResolvedValue({ pools: [], issues: [], stats: stats() });
  const pending = prepareNativeAprRun("uniswap-v4-rhc", input);
  input.lease.owner = "changed-owner"; input.lease.epoch = 99;
  input.store = {} as RwaStore; input.client = {} as PublicClient; input.clock = () => 9999;
  input.signal = new AbortController().signal; input.gate = new ThrottleGate(); input.fetcher = vi.fn<typeof fetch>();
  await pending;
  expect(backend.prepare).toHaveBeenCalledOnce();
  const captured = backend.prepare.mock.calls[0]![0] as NativeAprRunInput;
  expect(captured.lease).toEqual(original.lease);
  for (const field of ["store", "client", "clock", "signal", "gate", "fetcher"] as const) expect(captured[field]).toBe(original[field]);
});
it("keeps pool specs private and maps native outcomes while preserving live issues/counters", async () => {
  const spec = UNIV4_RHC_ALLOWLISTED_POOLS[0]!, counters = stats(), issues: string[] = [];
  const refreshPool = vi.fn().mockResolvedValueOnce("saved").mockResolvedValueOnce("failed")
    .mockResolvedValueOnce("degraded").mockResolvedValueOnce("throttled");
  backend.prepare.mockResolvedValue({ pools: [{ spec, poolId: spec.poolId, refreshedAt: null }], stats: counters, issues, refreshPool });
  const prepared = await prepareNativeAprRun("uniswap-v4-rhc", context());
  expect(prepared).not.toBeNull(); expect(prepared!.pools[0]).not.toHaveProperty("spec");
  expect(prepared!.stats).toBe(counters); expect(prepared!.issues).toBe(issues);
  for (const outcome of ["fresh", "error", "degraded", "throttled"]) expect(await prepared!.pools[0]!.refresh()).toEqual({ outcome, issue: null });
  expect(refreshPool.mock.calls).toEqual([[spec], [spec], [spec], [spec]]);
  counters.reused += 1; issues.push("late issue");
  expect(prepared!.stats.reused).toBe(1); expect(prepared!.issues).toEqual(["late issue"]);
});
it("returns null for modules without a native APR lane", async () => {
  for (const id of ["unknown", "raydium-clmm", "meteora-dlmm", "orca-whirlpool"]) expect(await prepareNativeAprRun(id, context())).toBeNull();
  expect(backend.prepare).not.toHaveBeenCalled();
});
