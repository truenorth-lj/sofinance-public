import { describe, expect, it } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { rhcPool, rhcPoolView, solanaPool, type RhcPoolSummary, type SolanaPoolRow } from "./rows";

const row: SolanaPoolRow = {
  poolAddress: "pool1", mintA: "mA", mintB: "mB", symbolA: "SPCXx", symbolB: "SPCX", nameA: "SpaceX xStock", nameB: "SpaceX",
  wrappedSymbol: "SPCXx", plainSymbol: "SPCX", feeTierBps: 25, tvlUsd: 1, volume24hUsd: 2, estimatedFeeAprPct: 3,
  token2022A: true, token2022B: false, freezeRisk: true,
};
const spec = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const summary = (over: Partial<RhcPoolSummary> = {}): RhcPoolSummary => ({
  poolId: spec.poolId, status: "listed", tick: 10, price: 1.01,
  estimatedApr: { tvlUsd: 5000, volume24hUsd: 700, estimatedPoolFeeAprPct: 12 } as RhcPoolSummary["estimatedApr"],
  warnings: [], token0: { name: "SpaceX", symbol: "SPCX" }, token1: { name: "SpaceX Ondo", symbol: "SPCXon" }, ...over,
});

describe("solanaPool", () => {
  it("maps a Raydium row with its risk flags", () => {
    const p = solanaPool(row);
    expect(p).toMatchObject({ key: "solana:pool1", chain: "solana", protocol: "raydium-clmm", pairLabel: "SPCXx/SPCX", poolFeeApr24hPct: 3 });
    expect(p.risks).toEqual(["freeze", "token-2022"]);
  });
  it("keeps the Orca / Meteora protocol from /api/protocol-pools", () => {
    expect(solanaPool({ ...row, protocol: "meteora-dlmm" }).protocol).toBe("meteora-dlmm");
    expect(solanaPool({ ...row, protocol: "something-else" }).protocol).toBe("raydium-clmm");
  });
});

describe("rhcPool", () => {
  it("maps the allowlisted SPCX/SPCXon pool on Robinhood Chain", () => {
    expect(rhcPool(summary())).toMatchObject({
      chain: "robinhood", protocol: "uniswap-v4-rhc", pairLabel: "SPCX/SPCXon", tvlUsd: 5000, volume24hUsd: 700, poolFeeApr24hPct: 12, risks: [],
    });
  });
  it("drops delisted and unknown pools and flags discovery warnings", () => {
    expect(rhcPool(summary({ status: "delisted" } as Partial<RhcPoolSummary>))).toBeNull();
    expect(rhcPool(summary({ poolId: "0xdead" }))).toBeNull();
    expect(rhcPool(summary({ warnings: ["thin liquidity"] } as Partial<RhcPoolSummary>))!.risks).toEqual(["pool-warning"]);
  });
  it("builds the open panel view from the reviewed allowlist tokens", () => {
    expect(rhcPoolView(summary())).toMatchObject({ poolId: spec.poolId, tick: 10, token0: { address: spec.currency0.address, decimals: spec.currency0.decimals } });
  });
});
