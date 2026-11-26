import { describe, expect, it } from "vitest";
import { dexDescriptors } from "@/lib/dex/client";
import { compoundAllRows, hasUnclaimedFees, type CompoundAllCandidate } from "./eligible-rows";

const MINT = "So11111111111111111111111111111111111111112";
const candidate = (over: Partial<CompoundAllCandidate["position"]> & { source: string }, fees: Partial<CompoundAllCandidate> = {}): CompoundAllCandidate => ({
  position: { key: `${over.source}:${over.nativeId ?? MINT}` as CompoundAllCandidate["position"]["key"], nativeId: MINT, rangeStatus: "in", liquidity: "10", ...over } as CompoundAllCandidate["position"],
  compoundSupported: true, unclaimedFeesUsd: 1, ...fees,
});
const descriptorFor = (dex: string) => dexDescriptors.descriptorFor(dex);

describe("compoundAllRows: only positions that still have fees", () => {
  it("lists Raydium (native-harvest) and Meteora (registry) positions with fees, in order; Meteora out of range is flagged", () => {
    const rows = compoundAllRows([
      candidate({ source: "raydium-clmm", nativeId: "r1" }),
      candidate({ source: "meteora-dlmm", nativeId: "m1", rangeStatus: "above" }),
      candidate({ source: "meteora-dlmm", nativeId: "m2", rangeStatus: "in" }),
    ], descriptorFor);
    expect(rows).toEqual([
      { key: "raydium-clmm:r1", dex: "raydium-clmm", flow: "native-harvest", positionId: "r1", outOfRange: false },
      { key: "meteora-dlmm:m1", dex: "meteora-dlmm", flow: "registry", positionId: "m1", outOfRange: true },
      { key: "meteora-dlmm:m2", dex: "meteora-dlmm", flow: "registry", positionId: "m2", outOfRange: false },
    ]);
  });
  it("leaves out positions with no fees, unread fees, closed positions, unsupported compound and non-Solana DEXes", () => {
    expect(compoundAllRows([
      candidate({ source: "raydium-clmm", nativeId: "zero" }, { unclaimedFeesUsd: 0 }),
      candidate({ source: "raydium-clmm", nativeId: "unread" }, { unclaimedFeesUsd: null }),
      candidate({ source: "raydium-clmm", nativeId: "closed", liquidity: "0" }),
      candidate({ source: "meteora-dlmm", nativeId: "nocompound" }, { compoundSupported: false }),
      candidate({ source: "orca-whirlpool", nativeId: "orca" }),
      candidate({ source: "uniswap-v4-rhc", nativeId: "rhc" }),
    ], descriptorFor)).toEqual([]);
  });
  it("raw unclaimed fees count even when the USD figure is missing", () => {
    expect(hasUnclaimedFees({ unclaimedFeesUsd: null, unclaimedFeesRaw: { a: "0", b: "12" } })).toBe(true);
    expect(hasUnclaimedFees({ unclaimedFeesUsd: null, unclaimedFeesRaw: { a: "0", b: "0" } })).toBe(false);
    expect(hasUnclaimedFees({ unclaimedFeesUsd: 0.01, unclaimedFeesRaw: null })).toBe(true);
    expect(hasUnclaimedFees({ unclaimedFeesUsd: null, unclaimedFeesRaw: { a: "x", b: "" } })).toBe(false);
  });
});
