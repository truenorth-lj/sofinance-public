import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { PositionLookup } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
import type { ScannedPosition } from "@sofinance/engine/protocols/uniswap-v4/position-scan";
import { DexError } from "../errors";
import { listRhcUnifiedPositions, rhcPositionSource } from "@/lib/unified-positions/sources/rhc";
import { positionDescriptorsFor } from "../positions-client";
import { dexDescriptors } from "../client";
import { createUniswapV4RhcAdapter } from "./adapter.server";

const POOL = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
/** Owner of on-chain position #4072237 (public; shortened in reports as 0xB95b…1b04). */
const OWNER = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04";

const lookup = (tokenId: string, over: Partial<NonNullable<PositionLookup["position"]>> = {}): PositionLookup => ({
  tokenId,
  position: {
    tokenId, owner: OWNER, ownedByUser: true, liquidity: "1000", tickLower: -10, tickUpper: 10,
    poolId: POOL.poolId, baseSymbol: POOL.baseSymbol, ...over,
  } as NonNullable<PositionLookup["position"]>,
});
const scanned = (tokenId: string, over: Partial<NonNullable<PositionLookup["position"]>> = {}): ScannedPosition => ({
  ...lookup(tokenId, over), hooks: null, stablePair: true,
});

const comparable = (positions: ReturnType<typeof listRhcUnifiedPositions>) => positions.map((p) => ({
  nativeId: p.nativeId,
  chain: p.chain,
  poolId: p.poolId,
  tokenA: p.tokenA,
  tokenB: p.tokenB,
  range: p.range,
  rangeStatus: p.rangeStatus,
  liquidity: p.liquidity,
  held: p.native.held !== null,
  priceRangeText: p.native.priceRange?.text ?? null,
}));

describe("uniswap-v4-rhc listPositions (E2-alias)", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("lists each position exactly once: the module and the source share one mapper (naive concat would double)", async () => {
    const holdings = [scanned("9"), scanned("5")];
    const discovery = { scanned: holdings, lookups: [lookup("5"), lookup("12")] };
    const fromSource = rhcPositionSource.fromDiscovery(discovery);
    const fromModule = await createUniswapV4RhcAdapter({ listHoldings: async () => holdings }).listPositions(OWNER);
    expect(rhcPositionSource.id).toBe("uniswap-v4-rhc");
    expect(fromSource.map((p) => p.nativeId)).toEqual(["9", "5", "12"]);
    expect(new Set(fromSource.map((p) => p.nativeId)).size).toBe(fromSource.length);
    expect(fromSource.every((p) => p.key === `uniswap-v4-rhc:${p.nativeId}` && p.source === "uniswap-v4-rhc")).toBe(true);
    expect(fromModule.map((p) => [p.key, p.nativeId])).toEqual([["uniswap-v4-rhc:9", "9"], ["uniswap-v4-rhc:5", "5"]]);
    expect(fromModule).toEqual(listRhcUnifiedPositions({ scanned: holdings, lookups: [] }));
    // If /app kept the old source list and also fetched the module list for the same scan, 9 and 5 would appear twice.
    const naive = [...fromModule, ...fromSource];
    const counts = Object.fromEntries(["9", "5", "12"].map((id) => [id, naive.filter((p) => p.nativeId === id).length]));
    expect(counts).toEqual({ "9": 2, "5": 2, "12": 1 });
    // Production composition: Solana registry does not also fetch RHC; the evm descriptor is the module's only generic path.
    expect(positionDescriptorsFor(dexDescriptors.descriptors, "solana-wallet").map((d) => d.id)).not.toContain("uniswap-v4-rhc");
    expect(positionDescriptorsFor(dexDescriptors.descriptors, "evm-wallet").map((d) => d.id)).toEqual(["uniswap-v4-rhc"]);
  });

  it("positions response for the fixed address is the same before and after except the canonical key and source", async () => {
    const discovery = {
      scanned: [scanned("4072237", { liquidity: "23244502727111678263", tickLower: -21, tickUpper: 19 })],
      lookups: [] as PositionLookup[],
    };
    // Frozen pre-alias shape (main a5b351b / E2-register): same row, leftover key spelling.
    const before = {
      key: "rhc-uniswap-v4:4072237",
      source: "rhc-uniswap-v4" as const,
      chain: "robinhood-chain" as const,
      nativeId: "4072237",
      poolId: POOL.poolId,
      tokenA: { id: POOL.currency0.address, symbol: POOL.currency0.symbol, decimals: POOL.currency0.decimals },
      tokenB: { id: POOL.currency1.address, symbol: POOL.currency1.symbol, decimals: POOL.currency1.decimals },
      range: { mode: "price" as const, lower: 0.9979, upper: 1.0019, current: null },
      rangeStatus: "unknown" as const,
      liquidity: "23244502727111678263",
      held: true,
      priceRangeText: `0.9979–1.0019 ${POOL.currency1.symbol} per ${POOL.currency0.symbol}`,
    };
    const afterList = await createUniswapV4RhcAdapter({ listHoldings: async () => discovery.scanned }).listPositions(OWNER);
    const fromSource = listRhcUnifiedPositions(discovery);
    expect(afterList).toEqual(fromSource);
    expect(afterList).toHaveLength(1);
    const after = afterList[0]!;
    expect(after.key).toBe("uniswap-v4-rhc:4072237");
    expect(after.source).toBe("uniswap-v4-rhc");
    expect({
      key: "rhc-uniswap-v4:4072237",
      source: "rhc-uniswap-v4",
      ...comparable(fromSource)[0]!,
      poolId: after.poolId,
    }).toEqual(before);
  });

  it("rejects an invalid owner before any scan", async () => {
    const listHoldings = vi.fn(async () => []);
    const adapter = createUniswapV4RhcAdapter({ listHoldings });
    await expect(adapter.listPositions("not-an-address")).rejects.toBeInstanceOf(DexError);
    expect(listHoldings).not.toHaveBeenCalled();
  });
});
