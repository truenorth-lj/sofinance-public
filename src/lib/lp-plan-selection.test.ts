import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_PAIR,
  DEFAULT_PLAN_POOL_ID,
  parsePairLabel,
  parseSolanaAddress,
  pairLabelFromSymbols,
  resolvePlanSelection,
} from "./lp-plan-selection";

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PAIRS = [
  { poolAddress: POOL, wrappedSymbol: "SPCXx", plainSymbol: "SPCX" },
  { poolAddress: OTHER, wrappedSymbol: "MSTRx", plainSymbol: "MSTR" },
];

describe("plan pool selection", () => {
  it("accepts a Solana address and rejects junk", () => {
    expect(parseSolanaAddress(POOL)).toBe(POOL);
    expect(parseSolanaAddress(` ${POOL} `)).toBe(POOL);
    expect(parseSolanaAddress("SPCXx/SPCX")).toBeUndefined();
    expect(parseSolanaAddress("")).toBeUndefined();
    expect(parseSolanaAddress("O0")).toBeUndefined();
  });

  it("keeps a pair label and refuses to treat an address as one", () => {
    expect(parsePairLabel("SPCXx/SPCX")).toBe("SPCXx/SPCX");
    expect(parsePairLabel(POOL)).toBeUndefined();
    expect(parsePairLabel("")).toBeUndefined();
    expect(pairLabelFromSymbols("SPCXx", "SPCX")).toBe("SPCXx/SPCX");
  });

  it("defaults to the SPCXx/SPCX pool when nothing is chosen", () => {
    expect(resolvePlanSelection({})).toEqual({ poolId: DEFAULT_PLAN_POOL_ID, pair: DEFAULT_PLAN_PAIR });
    expect(DEFAULT_PLAN_POOL_ID).toBe(POOL);
    expect(DEFAULT_PLAN_PAIR).toBe("SPCXx/SPCX");
  });

  it("keeps an explicit pool and fills the pair from the cached list", () => {
    expect(resolvePlanSelection({ poolId: OTHER, pairs: PAIRS })).toEqual({
      poolId: OTHER,
      pair: "MSTRx/MSTR",
    });
  });

  it("resolves a pair-only link from the cached list and leaves unknown pairs unresolved", () => {
    expect(resolvePlanSelection({ pair: "MSTRx/MSTR", pairs: PAIRS })).toEqual({
      poolId: OTHER,
      pair: "MSTRx/MSTR",
    });
    expect(resolvePlanSelection({ pair: "NVDAx/NVDA" })).toEqual({ pair: "NVDAx/NVDA" });
  });
});
