import { beforeEach, expect, it, vi } from "vitest";
import { loadHomepagePoolsSnapshot } from "./homepage-pools-snapshot";
import { payloadFixture } from "./range-apr/payload.fixture";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T>(read: T) => read }));
const backend = vi.hoisted(() => ({ enabled: false, solana: vi.fn(), rhc: vi.fn(), solanaApr: vi.fn(), rhcApr: vi.fn() }));
vi.mock("@/lib/rwa-store", () => ({ getRwaPairs: backend.solana, getPoolAprSnapshot: backend.solanaApr }));
vi.mock("@/lib/rhc-snapshot", () => ({ getRhcPoolsSnapshot: backend.rhc, getRhcAprSnapshot: backend.rhcApr }));
vi.mock("@/lib/protocol-flags", async load => ({ ...await load<typeof import("@/lib/protocol-flags")>(),
  isRhcApr7dEnabled: () => backend.enabled, isRhcUniv4DiscoveryEnabled: () => true }));
const spec = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
beforeEach(() => {
  vi.resetAllMocks(); backend.enabled = false;
  const at = new Date().toISOString();
  backend.solana.mockResolvedValue({ fetchedAt: at, pairs: [{ poolAddress: "solana-pool", protocol: "raydium-clmm", mintA: "a", mintB: "b",
    symbolA: "STOCKx", symbolB: "STOCK", nameA: "Stock x", nameB: "Stock", wrappedSymbol: "STOCKx", plainSymbol: "STOCK",
    feeTierBps: 25, tvlUsd: 100_000, volume24hUsd: 1000, estimatedFeeAprPct: 1, token2022A: false, token2022B: false, freezeRisk: false }] });
  backend.rhc.mockResolvedValue({ fetchedAt: at, snapshot: { stale: false }, pools: [{ poolId: spec.poolId, status: "listed", tick: 0, price: 1,
    estimatedApr: null, warnings: [], token0: { name: "A", symbol: spec.currency0.symbol }, token1: { name: "B", symbol: spec.currency1.symbol } }] });
  const payload = payloadFixture();
  payload.freshness = { snapshotAt: at, chainObservedAt: at, volumeObservedAt: at, stale: false };
  backend.solanaApr.mockResolvedValue(payload); backend.rhcApr.mockResolvedValue(payload);
});
it("keeps Solana APR reads enabled and skips RHC APR when its flag is off", async () => {
  const snapshot = await loadHomepagePoolsSnapshot();
  expect(snapshot).not.toBeNull();
  expect(snapshot!.pools.some(pool => pool.chain === "robinhood")).toBe(true);
  expect(backend.solanaApr).toHaveBeenCalledExactlyOnceWith("solana-pool");
  expect(backend.rhcApr).not.toHaveBeenCalled();
});
it("reads both saved APR sources when the same RHC flag is on", async () => {
  backend.enabled = true;
  expect(await loadHomepagePoolsSnapshot()).not.toBeNull();
  expect(backend.solanaApr).toHaveBeenCalledExactlyOnceWith("solana-pool");
  expect(backend.rhcApr).toHaveBeenCalledExactlyOnceWith(spec.poolId);
});
