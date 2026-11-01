import { describe, expect, it } from "vitest";
import type { UnifiedPosition } from "./model";
import { comparePositions, groupPositions, isClosed } from "./rows";

const p = (over: Partial<UnifiedPosition>): UnifiedPosition => ({
  key: `raydium-clmm:${over.nativeId ?? "x"}`, source: "raydium-clmm", chain: "solana", nativeId: "x", poolId: "P",
  tokenA: { id: "A", symbol: "A", decimals: 6 }, tokenB: { id: "B", symbol: "B", decimals: 6 },
  range: { mode: "tick", tickLower: 0, tickUpper: 1, currentTick: 0 }, rangeStatus: "in", liquidity: "1", native: null, ...over,
});

describe("comparePositions", () => {
  it("open before closed, in range first, then value desc with unpriced last", () => {
    const list = [
      p({ nativeId: "closed", liquidity: "0", valueUsd: 999 }),
      p({ nativeId: "out", rangeStatus: "below", valueUsd: 500 }),
      p({ nativeId: "unpriced", valueUsd: null }),
      p({ nativeId: "small", valueUsd: 1 }),
      p({ nativeId: "big", valueUsd: 100 }),
    ].sort(comparePositions).map((x) => x.nativeId);
    expect(list).toEqual(["big", "small", "unpriced", "out", "closed"]);
    expect(isClosed({ liquidity: "0" })).toBe(true);
  });
  it("ties break on source, pool, id", () => {
    const list = [p({ nativeId: "b" }), p({ nativeId: "a", poolId: "Q" }), p({ nativeId: "a" })].sort(comparePositions);
    expect(list.map((x) => `${x.poolId}${x.nativeId}`)).toEqual(["Pa", "Pb", "Qa"]);
  });
});

describe("groupPositions", () => {
  it("Solana first, then Robinhood Chain; drops empty chains", () => {
    const groups = groupPositions([p({ chain: "robinhood-chain", source: "rhc-uniswap-v4", nativeId: "7" }), p({ nativeId: "s" })]);
    expect(groups.map((g) => g.label)).toEqual(["Solana", "Robinhood Chain"]);
    expect(groupPositions([p({})]).map((g) => g.chain)).toEqual(["solana"]);
  });
  it("shows source names only with 2+ enabled sources on a chain", () => {
    expect(groupPositions([p({})], { solana: ["raydium-clmm"] })[0]!.showSourceName).toBe(false);
    expect(groupPositions([p({})], { solana: ["raydium-clmm", "orca-whirlpool"] })[0]!.showSourceName).toBe(true);
  });
});

describe("groupPositions keepEmpty and option labels", () => {
  it("keeps an empty chain group when asked (Solana + Robinhood Chain wallet with no RHC positions)", () => {
    const groups = groupPositions([p({ nativeId: "a" })], { solana: ["raydium-clmm"], "robinhood-chain": ["rhc-uniswap-v4"] }, ["solana", "robinhood-chain"]);
    expect(groups.map((g) => [g.label, g.positions.length])).toEqual([["Solana", 1], ["Robinhood Chain", 0]]);
    expect(groupPositions([], {}, ["robinhood-chain"]).map((g) => g.chain)).toEqual(["robinhood-chain"]);
  });
  it("labels liquidity-0 Solana rows Closed and adds the source name only when asked", async () => {
    const { positionOptionLabel } = await import("./rows");
    const source = { displayName: "Raydium CLMM", label: (x: UnifiedPosition) => `pos ${x.nativeId}` };
    expect(positionOptionLabel(source, p({ nativeId: "z", liquidity: "0" }))).toBe("pos z · Closed");
    expect(positionOptionLabel(source, p({ nativeId: "y" }), { showSourceName: true })).toBe("Raydium CLMM · pos y");
  });
});
