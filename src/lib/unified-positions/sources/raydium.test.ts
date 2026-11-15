import { describe, expect, it } from "vitest";
import type { WalletPosition } from "@sofinance/engine/wallet-discovery";
import { raydiumPositionSource, raydiumUnifiedPosition } from "./raydium";

const wp = (positionMint: string, rangeSide: WalletPosition["rangeSide"] = "inside"): WalletPosition => ({
  positionMint, positionAccount: `acc-${positionMint}`, poolId: "pool", mintA: "MA", mintB: "MB", symbolA: "A", symbolB: null,
  decimalsA: 6, decimalsB: 9, feeTierBps: 25, tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide, liquidity: "42",
});

describe("raydium position source", () => {
  it("keeps the scan order and passes the native record through unchanged", () => {
    const positions = [wp("z"), wp("a", "above"), wp("m", "below")];
    const unified = raydiumPositionSource.fromDiscovery({ positions });
    expect(unified.map((u) => u.native)).toEqual(positions);
    for (let i = 0; i < positions.length; i++) expect(unified[i]!.native).toBe(positions[i]);
    expect(unified.map((u) => u.rangeStatus)).toEqual(["in", "above", "below"]);
    expect(raydiumPositionSource.fromDiscovery(null)).toEqual([]);
  });
  it("maps fields", () => {
    expect(raydiumUnifiedPosition(wp("m1"))).toMatchObject({ key: "raydium-clmm:m1", chain: "solana", poolId: "pool", liquidity: "42",
      tokenA: { id: "MA", symbol: "A", decimals: 6 }, tokenB: { id: "MB", symbol: null, decimals: 9 },
      range: { mode: "tick", tickLower: -10, tickUpper: 10, currentTick: 0 } });
  });
  it("supports every /app tool today", () => {
    const c = raydiumPositionSource.capabilities;
    expect([c.compound, c.performance, c.deposit, c.withdraw, c.exitPreview].every((x) => x.supported)).toBe(true);
    expect(c.withdraw).toEqual({ supported: true, partial: true });
  });
});

